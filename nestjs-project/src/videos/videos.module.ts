import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoOwnerGuard } from './guards/video-owner.guard';
import { VideosUploadController } from './videos-upload.controller';
import { VideosUploadService } from './videos-upload.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosUploadController, VideosController],
  providers: [VideosUploadService, VideoOwnerGuard, VideosService],
  exports: [TypeOrmModule, VideosUploadService],
})
export class VideosModule {}
