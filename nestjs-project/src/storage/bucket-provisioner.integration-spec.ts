import {
  GetBucketLifecycleConfigurationCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';

describe('BucketProvisioner (integration)', () => {
  let module: TestingModule;
  let s3: S3Client;
  let uploadsBucket: string;
  let mediaBucket: string;
  let internalEndpoint: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    s3 = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const config = module.get(storageConfig.KEY);
    uploadsBucket = config.uploadsBucket;
    mediaBucket = config.mediaBucket;
    internalEndpoint = config.internalEndpoint;
  }, 20000);

  afterAll(async () => {
    await module.close();
  });

  it('creates both the uploads and the media buckets on boot', async () => {
    await expect(
      s3.send(new HeadBucketCommand({ Bucket: uploadsBucket })),
    ).resolves.toBeDefined();
    await expect(
      s3.send(new HeadBucketCommand({ Bucket: mediaBucket })),
    ).resolves.toBeDefined();
  });

  it('exposes the ETag header via CORS on the uploads bucket', async () => {
    // MinIO does not implement PutBucketCors/GetBucketCors — CORS is enabled
    // by default for every bucket and verb there, so the contract is proven
    // behaviorally: a cross-origin request against the uploads bucket must
    // come back with ETag listed in Access-Control-Expose-Headers.
    const response = await fetch(
      `${internalEndpoint}/${uploadsBucket}/cors-probe-key`,
      {
        method: 'PUT',
        headers: {
          Origin: 'http://localhost:3001',
          'Content-Type': 'text/plain',
        },
        body: 'probe',
      },
    );

    const exposedHeaders = response.headers.get(
      'access-control-expose-headers',
    );
    expect(exposedHeaders).toBeTruthy();
    expect(exposedHeaders?.toLowerCase()).toMatch(/etag|\*/);
  });

  it('attempts the incomplete-multipart-upload lifecycle rule without failing boot on MinIO', async () => {
    // MinIO rejects AbortIncompleteMultipartUpload inside PutBucketLifecycle
    // (documented limitation — no equivalent automatic behavior exists on
    // MinIO, unlike CORS). The provisioner already ran during beforeAll and
    // module boot succeeded, proving the InvalidArgument was tolerated
    // instead of crashing the app. GetBucketLifecycleConfiguration confirms
    // no rule was actually persisted in this environment.
    await expect(
      s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: uploadsBucket }),
      ),
    ).rejects.toThrow();
  });
});
