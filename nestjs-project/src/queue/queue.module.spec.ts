import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  beforeAll(() => {
    setDefaultBackendFactory(createPostgresBackend);
  });

  it('should compile and register the video queue with the configured default job options', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig],
        }),
        QueueModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken('video'));

    expect(module).toBeDefined();
    expect(queue).toBeDefined();
    expect(queue.opts.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    await queue.close();
    await module.close();
  }, 20000);
});
