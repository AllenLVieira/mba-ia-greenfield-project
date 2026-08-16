import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoProcessingStatus } from '../entities/video.entity';
import { PROCESSING_ERROR_CODES } from '../processing-error-code';
import { NoVideoStreamError } from './ffmpeg.errors';
import { FfmpegService, VideoMetadata } from './ffmpeg.service';

export interface ProcessVideoJobData {
  videoId: string;
}

interface ProbeResult {
  metadata: VideoMetadata;
  thumbnail: Buffer;
}

@Processor('video')
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData, void, string>): Promise<void> {
    const video = await this.loadVideoOrThrow(job.data.videoId);

    video.processingStatus = VideoProcessingStatus.PROCESSING;
    await this.videoRepository.save(video);

    const ingestKey = this.storageService.getIngestKey(
      video.id,
      extname(video.originalFilename),
    );

    let result: ProbeResult;
    try {
      result = await this.probeAndExtractThumbnail(video, ingestKey);
    } catch (error) {
      if (error instanceof NoVideoStreamError) {
        video.processingStatus = VideoProcessingStatus.FAILED;
        video.processingError = { code: error.code, message: error.message };
        await this.videoRepository.save(video);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    const { metadata, thumbnail } = result;

    video.durationSeconds = metadata.durationSeconds;
    video.width = metadata.width;
    video.height = metadata.height;
    video.container = metadata.container;
    video.videoCodec = metadata.videoCodec;
    video.audioCodec = metadata.audioCodec;
    video.sizeBytes = metadata.sizeBytes;

    const thumbnailKey = this.storageService.getThumbnailKey(video.id);
    await this.storageService.putMediaObject(
      thumbnailKey,
      thumbnail,
      'image/jpeg',
    );

    const mediaKey = this.storageService.getMediaKey(
      video.id,
      extname(video.originalFilename),
    );
    await this.storageService.copyToMedia(
      ingestKey,
      mediaKey,
      video.contentType,
    );

    video.processingStatus = VideoProcessingStatus.READY;
    await this.videoRepository.save(video);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData, void, string> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || error instanceof UnrecoverableError) {
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      return;
    }

    video.processingStatus = VideoProcessingStatus.FAILED;
    video.processingError = {
      code: PROCESSING_ERROR_CODES.PROCESSING_FAILED,
      message: error.message,
    };
    await this.videoRepository.save(video);
    this.logger.warn(
      `Video ${video.id} processing failed after exhausting retry budget: ${error.message}`,
    );
  }

  private async probeAndExtractThumbnail(
    video: Video,
    ingestKey: string,
  ): Promise<ProbeResult> {
    const presignedUrl =
      await this.storageService.presignIngestGetObject(ingestKey);

    try {
      const metadata = await this.ffmpegService.probe(presignedUrl);
      const thumbnail = await this.ffmpegService.extractThumbnail(
        presignedUrl,
        metadata.durationSeconds,
      );
      return { metadata, thumbnail };
    } catch (error) {
      if (error instanceof NoVideoStreamError) {
        throw error;
      }
      return this.probeAndExtractThumbnailFromLocalDownload(video, ingestKey);
    }
  }

  private async probeAndExtractThumbnailFromLocalDownload(
    video: Video,
    ingestKey: string,
  ): Promise<ProbeResult> {
    const tempFilePath = join(
      tmpdir(),
      `video-${video.id}-${randomUUID()}${extname(video.originalFilename)}`,
    );
    try {
      await this.storageService.downloadIngestObjectToFile(
        ingestKey,
        tempFilePath,
      );
      const metadata = await this.ffmpegService.probe(tempFilePath);
      const thumbnail = await this.ffmpegService.extractThumbnail(
        tempFilePath,
        metadata.durationSeconds,
      );
      return { metadata, thumbnail };
    } finally {
      await unlink(tempFilePath).catch(() => undefined);
    }
  }

  private async loadVideoOrThrow(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new UnrecoverableError(`Video ${videoId} not found`);
    }
    return video;
  }
}
