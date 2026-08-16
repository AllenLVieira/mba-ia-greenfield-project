import { NestFactory } from '@nestjs/core';
import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import { WorkerModule } from './worker.module';

// Process-wide: must run before any module instantiates a queue.
// `@nestjs/bullmq@11` does not expose a `BackendFactory` pass-through
// (per `phase-03-videos/TD-01`).
setDefaultBackendFactory(createPostgresBackend);

async function bootstrap() {
  // No network listener — the worker only consumes the `video` queue
  // (per `phase-03-videos/TD-07`).
  await NestFactory.createApplicationContext(WorkerModule);
}
void bootstrap();
