import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          connectionString: config.connectionString,
          schema: config.schema,
        },
      }),
    }),
    BullModule.registerQueueAsync({
      name: 'video',
      useFactory: () => ({
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
