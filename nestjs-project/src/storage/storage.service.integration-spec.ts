import {
  CreateMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let service: StorageService;
  let s3: S3Client;
  let uploadsBucket: string;
  let mediaBucket: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    service = module.get(StorageService);
    s3 = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const config = module.get(storageConfig.KEY);
    uploadsBucket = config.uploadsBucket;
    mediaBucket = config.mediaBucket;
  }, 20000);

  afterAll(async () => {
    await module.close();
  });

  it('produces the same key on repeated derivation calls for the same videoId', () => {
    const videoId = 'a1b2c3';

    expect(service.getIngestKey(videoId, '.mp4')).toBe(
      service.getIngestKey(videoId, '.mp4'),
    );
    expect(service.getMediaKey(videoId, '.mp4')).toBe(
      service.getMediaKey(videoId, '.mp4'),
    );
    expect(service.getThumbnailKey(videoId)).toBe(
      service.getThumbnailKey(videoId),
    );
  });

  it('copies an ingest object into the media bucket preserving the given ContentType', async () => {
    const videoId = 'copy-test';
    const sourceKey = service.getIngestKey(videoId, '.mp4');
    const destinationKey = service.getMediaKey(videoId, '.mp4');

    await s3.send(
      new PutObjectCommand({
        Bucket: uploadsBucket,
        Key: sourceKey,
        Body: Buffer.from('fake-video-bytes'),
      }),
    );

    await service.copyToMedia(sourceKey, destinationKey, 'video/mp4');

    const head = await service.headObject(mediaBucket, destinationKey);
    expect(head.ContentType).toBe('video/mp4');
  });

  it('heads an existing object and returns its metadata', async () => {
    const key = 'head-test/object.bin';
    await s3.send(
      new PutObjectCommand({
        Bucket: uploadsBucket,
        Key: key,
        Body: Buffer.from('hello'),
        ContentType: 'application/octet-stream',
      }),
    );

    const head = await service.headObject(uploadsBucket, key);

    expect(head.ContentType).toBe('application/octet-stream');
  });

  it('aborts an in-progress multipart upload', async () => {
    const key = 'abort-test/object.bin';
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: uploadsBucket, Key: key }),
    );

    await service.abortMultipartUpload(key, UploadId as string);

    await expect(
      s3.send(
        new ListPartsCommand({
          Bucket: uploadsBucket,
          Key: key,
          UploadId: UploadId as string,
        }),
      ),
    ).rejects.toThrow();
  });
});
