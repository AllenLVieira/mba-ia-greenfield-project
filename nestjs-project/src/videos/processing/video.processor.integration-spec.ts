import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { S3_INTERNAL_CLIENT } from '../../storage/storage.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoProcessingStatus } from '../entities/video.entity';
import { PROCESSING_ERROR_CODES } from '../processing-error-code';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, Video];
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'test', 'fixtures');

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessor;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let internalS3: S3Client;
  let uploadsBucket: string;
  let mediaBucket: string;

  beforeAll(async () => {
    setDefaultBackendFactory(createPostgresBackend);

    const ds = createTestDataSource(ALL_ENTITIES);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature(ALL_ENTITIES),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessor],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    processor = module.get(VideoProcessor);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storageService = module.get(StorageService);
    internalS3 = module.get<S3Client>(S3_INTERNAL_CLIENT);
    uploadsBucket = module.get(storageConfig.KEY).uploadsBucket;
    mediaBucket = module.get(storageConfig.KEY).mediaBucket;
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `proc_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function createVideoWithIngestObject(
    channel: Channel,
    fixtureName: string,
    extension: string,
  ): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        publicSlug: `slug${counter}${Date.now()}`.slice(0, 11),
        title: 'Test video',
        channelId: channel.id,
        processingStatus: VideoProcessingStatus.UPLOADING,
        originalFilename: `movie${extension}`,
        contentType: 'video/mp4',
        sizeBytes: '1000',
      }),
    );

    const key = storageService.getIngestKey(video.id, extension);
    const body = readFileSync(join(FIXTURES_DIR, fixtureName));
    await internalS3.send(
      new PutObjectCommand({ Bucket: uploadsBucket, Key: key, Body: body }),
    );

    return video;
  }

  it('processes a real video against MinIO and DB: video ends READY with metadata, thumbnail, and promoted media object', async () => {
    const channel = await createChannel();
    const video = await createVideoWithIngestObject(
      channel,
      'sample-video.mp4',
      '.mp4',
    );

    await processor.process({ data: { videoId: video.id } } as any);

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.processingStatus).toBe(VideoProcessingStatus.READY);
    expect(updated.durationSeconds).toBeGreaterThanOrEqual(19);
    expect(updated.width).toBe(640);
    expect(updated.height).toBe(480);
    expect(updated.videoCodec).toBe('h264');
    expect(updated.audioCodec).toBe('aac');

    const mediaKey = storageService.getMediaKey(video.id, '.mp4');
    const mediaHead = await internalS3.send(
      new HeadObjectCommand({ Bucket: mediaBucket, Key: mediaKey }),
    );
    expect(mediaHead.ContentType).toBe(video.contentType);

    const thumbnailKey = storageService.getThumbnailKey(video.id);
    const thumbnailHead = await internalS3.send(
      new HeadObjectCommand({ Bucket: mediaBucket, Key: thumbnailKey }),
    );
    expect(thumbnailHead.ContentType).toBe('image/jpeg');
    expect(thumbnailHead.ContentLength).toBeGreaterThan(0);
  }, 30000);

  it('marks the video FAILED with NO_VIDEO_STREAM for an audio-only ingest object, preserving the source object', async () => {
    const channel = await createChannel();
    const video = await createVideoWithIngestObject(
      channel,
      'sample-audio-only.m4a',
      '.m4a',
    );

    await expect(
      processor.process({ data: { videoId: video.id } } as any),
    ).rejects.toThrow();

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.processingStatus).toBe(VideoProcessingStatus.FAILED);
    expect(updated.processingError?.code).toBe(
      PROCESSING_ERROR_CODES.NO_VIDEO_STREAM,
    );

    const ingestKey = storageService.getIngestKey(video.id, '.m4a');
    await expect(
      internalS3.send(
        new GetObjectCommand({ Bucket: uploadsBucket, Key: ingestKey }),
      ),
    ).resolves.toBeDefined();
  }, 30000);

  it('reprocessing the same video overwrites the media/thumbnail keys instead of creating duplicates', async () => {
    const channel = await createChannel();
    const video = await createVideoWithIngestObject(
      channel,
      'sample-video.mp4',
      '.mp4',
    );

    await processor.process({ data: { videoId: video.id } } as any);
    const thumbnailKey = storageService.getThumbnailKey(video.id);
    const mediaKey = storageService.getMediaKey(video.id, '.mp4');
    const firstThumbnailHead = await internalS3.send(
      new HeadObjectCommand({ Bucket: mediaBucket, Key: thumbnailKey }),
    );

    // Reprocessing must reuse the SAME videoId-addressed key (per TD-06
    // idempotency) — a re-run overwrites rather than creating a second object.
    await videoRepository.update(video.id, {
      processingStatus: VideoProcessingStatus.UPLOADING,
    });
    await processor.process({ data: { videoId: video.id } } as any);
    const secondThumbnailHead = await internalS3.send(
      new HeadObjectCommand({ Bucket: mediaBucket, Key: thumbnailKey }),
    );

    expect(secondThumbnailHead.LastModified?.getTime()).toBeGreaterThanOrEqual(
      firstThumbnailHead.LastModified?.getTime() ?? 0,
    );

    const mediaHead = await internalS3.send(
      new HeadObjectCommand({ Bucket: mediaBucket, Key: mediaKey }),
    );
    expect(mediaHead).toBeDefined();

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.processingStatus).toBe(VideoProcessingStatus.READY);
  }, 30000);
});
