import { Client } from 'pg';
import databaseConfig from '../config/database.config';
import { runQueueMigrations } from './queue-migrations';

describe('runQueueMigrations (integration)', () => {
  let adminClient: Client;

  beforeAll(async () => {
    const db = databaseConfig();
    adminClient = new Client({
      host: db.host,
      port: db.port,
      user: db.username,
      password: db.password,
      database: db.name,
    });
    await adminClient.connect();
  });

  afterAll(async () => {
    await adminClient.end();
  });

  it('creates the bullmq schema in PostgreSQL', async () => {
    await runQueueMigrations();

    const result = await adminClient.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'bullmq'`,
    );

    expect(result.rows).toHaveLength(1);
  });

  it('converges to the same schema version when run concurrently', async () => {
    const [versionA, versionB] = await Promise.all([
      runQueueMigrations(),
      runQueueMigrations(),
    ]);

    expect(versionA).toBe(versionB);
  });
});
