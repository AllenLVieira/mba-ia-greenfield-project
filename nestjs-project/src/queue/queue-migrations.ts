import { runMigrations } from 'bullmq';
import { Client } from 'pg';
import queueConfig from '../config/queue.config';

/**
 * Runs BullMQ's PostgreSQL-backend schema migrations on a dedicated session
 * (never the app's TypeORM connection or pool) — advisory locks make this
 * safe to run concurrently from the API and the worker at boot (per
 * `phase-03-videos/TD-01`). Deliberately separate from TypeORM's own
 * `migration:run` — BullMQ owns its schema independently.
 */
export async function runQueueMigrations(): Promise<number> {
  const config = queueConfig();
  const client = new Client({ connectionString: config.connectionString });

  await client.connect();
  try {
    return await runMigrations(client, config.schema);
  } finally {
    await client.end();
  }
}
