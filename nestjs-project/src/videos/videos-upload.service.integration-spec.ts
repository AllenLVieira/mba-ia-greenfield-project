import { UploadPartCommand, type S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosUploadService } from './videos-upload.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosUploadService (integration)', () => {
  let module: TestingModule;
  let service: VideosUploadService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let queue: Queue;
  let internalS3: S3Client;
  let uploadsBucket: string;

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
        VideosModule,
      ],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    service = module.get(VideosUploadService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    queue = module.get<Queue>(getQueueToken('video'));
    internalS3 = module.get<S3Client>(S3_INTERNAL_CLIENT);
    uploadsBucket = module.get(storageConfig.KEY).uploadsBucket;
  }, 30000);

  afterAll(async () => {
    await queue.close();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    // `drain` only clears waiting/delayed jobs; with `removeOnFail: false` and a
    // live `video-worker` consuming the shared Postgres queue, failed jobs from
    // prior runs pile up and inflate `getJobCounts`. `obliterate` wipes every
    // state so this test only ever sees the single job it enqueues.
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `upload_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `up_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('runs initiate -> signPart -> complete against real MinIO and DB, enqueueing exactly one job', async () => {
    const channel = await createChannel();

    const { video, key } = await service.initiate(channel.user_id, {
      filename: 'movie.mp4',
      sizeBytes: 2048,
      contentType: 'video/mp4',
    });

    expect(key).toContain(video.id);
    expect(video.uploadId).toBeTruthy();

    const uploadId = video.uploadId as string;
    const url = await service.signPart(channel.user_id, uploadId, 1);
    expect(url).toContain('partNumber=1');

    // The presigned URL targets the *public* MinIO endpoint (localhost),
    // which is unreachable from inside this container's network. Upload the
    // real bytes via the internal client so `complete` finalizes against a
    // genuine ETag instead of following the client-side PUT this service
    // never performs.
    const { ETag } = await internalS3.send(
      new UploadPartCommand({
        Bucket: uploadsBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: Buffer.from('fake-video-bytes'),
      }),
    );

    const completed = await service.complete(channel.user_id, uploadId, [
      { ETag: ETag as string, PartNumber: 1 },
    ]);

    expect(completed.video.uploadId).toBeNull();
    expect(completed.location).toEqual(expect.any(String));

    const jobCounts = await queue.getJobCounts();
    const totalJobs = Object.values(jobCounts).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    );
    expect(totalJobs).toBe(1);

    const job = await queue.getJob(video.id);
    expect(job).toBeDefined();
    expect(job?.data).toEqual({ videoId: video.id });
  }, 30000);
});
