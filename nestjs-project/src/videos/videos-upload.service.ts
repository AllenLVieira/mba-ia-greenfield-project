import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { basename, extname } from 'node:path';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadStateException,
  UploadNotFoundException,
  VideoAccessDeniedException,
} from '../common/exceptions/domain.exception';
import {
  CompletedUploadPart,
  StorageService,
} from '../storage/storage.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { generatePublicSlug } from './public-slug.util';

export interface InitiateUploadInput {
  filename: string;
  sizeBytes: number;
  contentType: string;
}

export interface InitiateUploadResult {
  video: Video;
  key: string;
}

const PROCESS_VIDEO_JOB = 'process-video';
const VIDEO_QUEUE = 'video';

function deriveTitle(filename: string): string {
  const extension = extname(filename);
  const title = basename(filename, extension);
  return title.length > 0 ? title : filename;
}

function deriveIngestExtension(filename: string): string {
  return extname(filename);
}

@Injectable()
export class VideosUploadService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue(VIDEO_QUEUE) private readonly videoQueue: Queue,
  ) {}

  async initiate(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<InitiateUploadResult> {
    const channel = await this.resolveChannelOrThrow(userId);

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        publicSlug: generatePublicSlug(),
        title: deriveTitle(input.filename),
        channelId: channel.id,
        originalFilename: input.filename,
        contentType: input.contentType,
        sizeBytes: String(input.sizeBytes),
      }),
    );

    const key = this.storageService.getIngestKey(
      video.id,
      deriveIngestExtension(input.filename),
    );
    const uploadId = await this.storageService.createMultipartUpload(
      key,
      input.contentType,
    );

    video.uploadId = uploadId;
    await this.videoRepository.save(video);

    return { video, key };
  }

  async signPart(
    userId: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const video = await this.assertOwnership(userId, uploadId);

    const key = this.storageService.getIngestKey(
      video.id,
      deriveIngestExtension(video.originalFilename),
    );
    const url = await this.storageService.presignUploadPart(
      key,
      uploadId,
      partNumber,
    );

    if (video.processingStatus === VideoProcessingStatus.PENDING_UPLOAD) {
      video.processingStatus = VideoProcessingStatus.UPLOADING;
      await this.videoRepository.save(video);
    }

    return url;
  }

  async complete(
    userId: string,
    uploadId: string,
    parts: CompletedUploadPart[],
  ): Promise<{ video: Video; location: string }> {
    const video = await this.assertOwnership(userId, uploadId);

    const key = this.storageService.getIngestKey(
      video.id,
      deriveIngestExtension(video.originalFilename),
    );
    const orderedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const location = await this.storageService.completeMultipartUpload(
      key,
      uploadId,
      orderedParts,
    );

    video.uploadId = null;
    await this.videoRepository.save(video);

    await this.videoQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      { jobId: video.id },
    );

    return { video, location };
  }

  async abort(userId: string, uploadId: string): Promise<void> {
    const video = await this.assertOwnershipOnly(userId, uploadId);

    const key = this.storageService.getIngestKey(
      video.id,
      deriveIngestExtension(video.originalFilename),
    );
    await this.storageService.abortMultipartUpload(key, uploadId);

    video.uploadId = null;
    await this.videoRepository.save(video);
  }

  private async resolveChannelOrThrow(userId: string) {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoAccessDeniedException();
    }
    return channel;
  }

  private async findByUploadIdOrThrow(uploadId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { uploadId } });
    if (!video) {
      throw new UploadNotFoundException();
    }
    return video;
  }

  private async checkOwnership(userId: string, video: Video): Promise<void> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channelId) {
      throw new VideoAccessDeniedException();
    }
  }

  /**
   * Ownership-only check, used by routes with no state requirement (abort).
   * Delegated to by `VideoOwnerGuard` — see `.claude/rules/nestjs-layer-separation.md`.
   */
  async assertOwnershipOnly(userId: string, uploadId: string): Promise<Video> {
    const video = await this.findByUploadIdOrThrow(uploadId);
    await this.checkOwnership(userId, video);
    return video;
  }

  /**
   * Ownership + open-state check, used by routes that mutate an in-flight upload
   * (sign-part, complete). Delegated to by `VideoOwnerGuard`.
   */
  async assertOwnership(userId: string, uploadId: string): Promise<Video> {
    const video = await this.findByUploadIdOrThrow(uploadId);
    await this.checkOwnership(userId, video);

    if (
      video.processingStatus !== VideoProcessingStatus.PENDING_UPLOAD &&
      video.processingStatus !== VideoProcessingStatus.UPLOADING
    ) {
      throw new InvalidUploadStateException();
    }

    return video;
  }
}
