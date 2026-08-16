import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import {
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';

export interface PresignedUrlResult {
  url: string;
  expiresIn: number;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async findOwnedByPublicSlug(
    userId: string,
    publicSlug: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { publicSlug } });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channelId) {
      throw new VideoAccessDeniedException();
    }

    return video;
  }

  async getStatus(userId: string, publicSlug: string): Promise<Video> {
    return this.findOwnedByPublicSlug(userId, publicSlug);
  }

  async getPlaybackUrl(
    userId: string,
    publicSlug: string,
  ): Promise<PresignedUrlResult> {
    const video = await this.findOwnedByPublicSlug(userId, publicSlug);
    this.assertReady(video);

    const key = this.storageService.getMediaKey(
      video.id,
      extensionOf(video.originalFilename),
    );
    const expiresIn = this.config.presignTtlSeconds;
    const url = await this.storageService.presignMediaGetObject(key, expiresIn);

    return { url, expiresIn };
  }

  async getDownloadUrl(
    userId: string,
    publicSlug: string,
  ): Promise<PresignedUrlResult> {
    const video = await this.findOwnedByPublicSlug(userId, publicSlug);
    this.assertReady(video);

    const key = this.storageService.getMediaKey(
      video.id,
      extensionOf(video.originalFilename),
    );
    const expiresIn = this.config.presignTtlSeconds;
    const contentDisposition = `attachment; filename="${video.originalFilename}"`;
    const url = await this.storageService.presignMediaGetObject(
      key,
      expiresIn,
      contentDisposition,
    );

    return { url, expiresIn };
  }

  private assertReady(video: Video): void {
    if (video.processingStatus !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }
  }
}
