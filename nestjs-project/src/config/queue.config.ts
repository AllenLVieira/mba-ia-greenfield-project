import { registerAs } from '@nestjs/config';

/**
 * Reuses the existing PostgreSQL database (per `phase-03-videos/TD-01`) —
 * no dedicated queue credentials, just a separate schema namespace so
 * BullMQ's tables stay out of the application's own tables.
 */
export default registerAs('queue', () => {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const username = process.env.DB_USERNAME || 'streamtube';
  const password = process.env.DB_PASSWORD || 'streamtube';
  const database = process.env.DB_NAME || 'streamtube';

  return {
    connectionString: `postgres://${username}:${password}@${host}:${port}/${database}`,
    schema: process.env.QUEUE_SCHEMA || 'bullmq',
  };
});
