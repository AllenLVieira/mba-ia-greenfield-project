import queueConfig from './queue.config';

describe('queueConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds a connection string from the DB env vars, defaulting the schema', () => {
    process.env.DB_HOST = 'db';
    process.env.DB_PORT = '5432';
    process.env.DB_USERNAME = 'streamtube';
    process.env.DB_PASSWORD = 'streamtube';
    process.env.DB_NAME = 'streamtube';
    delete process.env.QUEUE_SCHEMA;

    const config = queueConfig();

    expect(config.connectionString).toBe(
      'postgres://streamtube:streamtube@db:5432/streamtube',
    );
    expect(config.schema).toBe('bullmq');
  });

  it('reads QUEUE_SCHEMA when set', () => {
    process.env.QUEUE_SCHEMA = 'custom_schema';

    const config = queueConfig();

    expect(config.schema).toBe('custom_schema');
  });
});
