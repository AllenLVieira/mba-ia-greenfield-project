import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { BucketProvisioner } from './bucket-provisioner';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and provide two distinct S3 clients', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(BucketProvisioner)
      .useValue({ onModuleInit: jest.fn() })
      .compile();

    const internalClient = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const publicClient = module.get<S3Client>(S3_PUBLIC_CLIENT);
    const storageService = module.get(StorageService);

    expect(module).toBeDefined();
    expect(internalClient).toBeInstanceOf(S3Client);
    expect(publicClient).toBeInstanceOf(S3Client);
    expect(internalClient).not.toBe(publicClient);
    expect(storageService).toBeDefined();

    await module.close();
  }, 15000);

  it('signs URLs against the endpoint each client was configured with', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(BucketProvisioner)
      .useValue({ onModuleInit: jest.fn() })
      .compile();

    const internalClient = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const publicClient = module.get<S3Client>(S3_PUBLIC_CLIENT);
    const command = new GetObjectCommand({ Bucket: 'bucket', Key: 'key' });

    const internalUrl = await getSignedUrl(internalClient, command);
    const publicUrl = await getSignedUrl(publicClient, command);

    expect(new URL(internalUrl).host).toBe('minio:9000');
    expect(new URL(publicUrl).host).toBe('localhost:9000');

    await module.close();
  }, 15000);
});
