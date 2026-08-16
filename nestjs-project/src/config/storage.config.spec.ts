import storageConfig from './storage.config';

const STORAGE_KEYS = [
  'STORAGE_INTERNAL_ENDPOINT',
  'STORAGE_PUBLIC_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_UPLOADS_BUCKET',
  'STORAGE_MEDIA_BUCKET',
  'STORAGE_PRESIGN_TTL_SECONDS',
] as const;

describe('storageConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // dotenv/config populates process.env for the whole Jest process, so the
    // storage keys must be cleared explicitly to exercise the factory defaults.
    process.env = { ...originalEnv };
    for (const key of STORAGE_KEYS) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should map every storage env var onto the typed config object', () => {
    process.env.STORAGE_INTERNAL_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://localhost:9000';
    process.env.STORAGE_REGION = 'eu-west-1';
    process.env.STORAGE_ACCESS_KEY_ID = 'access-key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'secret-key';
    process.env.STORAGE_UPLOADS_BUCKET = 'uploads';
    process.env.STORAGE_MEDIA_BUCKET = 'media';
    process.env.STORAGE_PRESIGN_TTL_SECONDS = '900';

    expect(storageConfig()).toEqual({
      internalEndpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'eu-west-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      uploadsBucket: 'uploads',
      mediaBucket: 'media',
      presignTtlSeconds: 900,
    });
  });

  it('should keep the internal and public endpoints distinct', () => {
    process.env.STORAGE_INTERNAL_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://localhost:9000';

    const config = storageConfig();

    expect(config.internalEndpoint).not.toBe(config.publicEndpoint);
    expect(config.internalEndpoint).toContain('minio');
  });

  it('should default presignTtlSeconds to 3600 when unset', () => {
    expect(storageConfig().presignTtlSeconds).toBe(3600);
  });

  it('should coerce presignTtlSeconds to a number', () => {
    process.env.STORAGE_PRESIGN_TTL_SECONDS = '1800';

    expect(storageConfig().presignTtlSeconds).toBe(1800);
  });

  it('should default region to us-east-1 when unset', () => {
    expect(storageConfig().region).toBe('us-east-1');
  });
});
