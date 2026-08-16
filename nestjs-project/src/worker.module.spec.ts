import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import { DataSource } from 'typeorm';
import { StorageService } from './storage/storage.service';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  beforeAll(() => {
    setDefaultBackendFactory(createPostgresBackend);
  });

  it('compiles the standalone worker context wiring config, TypeORM, queue and storage', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(DataSource)).toBeInstanceOf(DataSource);
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);

    const queue = module.get<Queue>(getQueueToken('video'));
    expect(queue).toBeDefined();

    await queue.close();
    await module.get(DataSource).destroy();
    await module.close();
  }, 20000);
});
