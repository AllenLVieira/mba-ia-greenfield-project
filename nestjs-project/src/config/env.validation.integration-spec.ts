import { envValidationSchema } from './env.validation';

const requiredStorageEnv = {
  STORAGE_INTERNAL_ENDPOINT: 'http://minio:9000',
  STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'access-key',
  STORAGE_SECRET_ACCESS_KEY: 'secret-key',
  STORAGE_UPLOADS_BUCKET: 'streamtube-uploads',
  STORAGE_MEDIA_BUCKET: 'streamtube-media',
};

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  ...requiredStorageEnv,
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage', () => {
  const validateWithout = (omittedKey: string) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[omittedKey];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
  };

  it.each(Object.keys(requiredStorageEnv))(
    'should reject an env missing %s, naming the missing key',
    (key) => {
      const { error } = validateWithout(key);

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should accept an env carrying every required storage key', () => {
    const { error } = validate({});

    expect(error).toBeUndefined();
  });

  it('should reject a non-URI storage endpoint', () => {
    const { error } = validate({ STORAGE_INTERNAL_ENDPOINT: 'minio:9000' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_INTERNAL_ENDPOINT');
  });

  it('should reject a non-positive presign TTL', () => {
    const { error } = validate({ STORAGE_PRESIGN_TTL_SECONDS: '0' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_PRESIGN_TTL_SECONDS');
  });

  it('should apply defaults for region and presign TTL when unset', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_PRESIGN_TTL_SECONDS).toBe(3600);
  });
});
