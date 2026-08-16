import { NestFactory } from '@nestjs/core';
import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { buildSwaggerDocument } from './swagger/swagger-document';

// Same requirement as `main.ts`: must run before any module instantiates a
// queue (per `phase-03-videos/TD-01`).
setDefaultBackendFactory(createPostgresBackend);

export async function exportSpec(outputPath = 'openapi.json'): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = buildSwaggerDocument(app);
  writeFileSync(outputPath, JSON.stringify(document, null, 2));
  await app.close();
}

if (require.main === module) {
  void exportSpec();
}
