import { UnrecoverableError } from 'bullmq';
import { VideoProcessor } from './video.processor';
import { Video, VideoProcessingStatus } from '../entities/video.entity';
import { NoVideoStreamError } from './ffmpeg.errors';
import { PROCESSING_ERROR_CODES } from '../processing-error-code';

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    publicSlug: 'abc',
    title: 'My Video',
    channelId: 'channel-1',
    processingStatus: VideoProcessingStatus.UPLOADING,
    processingError: null,
    originalFilename: 'my-video.mp4',
    contentType: 'video/mp4',
    sizeBytes: '1000',
    uploadId: null,
    durationSeconds: null,
    width: null,
    height: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

describe('VideoProcessor', () => {
  let videoRepository: { findOneBy: jest.Mock; save: jest.Mock };
  let storageService: {
    getIngestKey: jest.Mock;
    getMediaKey: jest.Mock;
    getThumbnailKey: jest.Mock;
    presignIngestGetObject: jest.Mock;
    downloadIngestObjectToFile: jest.Mock;
    putMediaObject: jest.Mock;
    copyToMedia: jest.Mock;
  };
  let ffmpegService: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let processor: VideoProcessor;

  const metadata = {
    durationSeconds: 100,
    width: 1920,
    height: 1080,
    sizeBytes: '5000',
    container: 'mov',
    videoCodec: 'h264',
    audioCodec: 'aac',
  };
  const thumbnail = Buffer.from('jpeg-bytes');

  beforeEach(() => {
    videoRepository = { findOneBy: jest.fn(), save: jest.fn((v) => v) };
    storageService = {
      getIngestKey: jest.fn(() => 'ingest-key'),
      getMediaKey: jest.fn(() => 'media-key'),
      getThumbnailKey: jest.fn(() => 'thumbnail-key'),
      presignIngestGetObject: jest
        .fn()
        .mockResolvedValue('https://presigned-url'),
      downloadIngestObjectToFile: jest.fn().mockResolvedValue(undefined),
      putMediaObject: jest.fn().mockResolvedValue(undefined),
      copyToMedia: jest.fn().mockResolvedValue(undefined),
    };
    ffmpegService = { probe: jest.fn(), extractThumbnail: jest.fn() };
    processor = new VideoProcessor(
      videoRepository as any,
      storageService as any,
      ffmpegService as any,
    );
  });

  describe('process', () => {
    it('transitions PENDING -> PROCESSING -> READY on a successful job', async () => {
      const video = buildVideo();
      videoRepository.findOneBy.mockResolvedValue(video);
      ffmpegService.probe.mockResolvedValue(metadata);
      ffmpegService.extractThumbnail.mockResolvedValue(thumbnail);
      const savedStatuses: VideoProcessingStatus[] = [];
      videoRepository.save.mockImplementation((v: Video) => {
        savedStatuses.push(v.processingStatus);
        return v;
      });

      await processor.process({ data: { videoId: video.id } } as any);

      expect(savedStatuses).toEqual([
        VideoProcessingStatus.PROCESSING,
        VideoProcessingStatus.READY,
      ]);
      expect(storageService.putMediaObject).toHaveBeenCalledWith(
        'thumbnail-key',
        thumbnail,
        'image/jpeg',
      );
      expect(storageService.copyToMedia).toHaveBeenCalledWith(
        'ingest-key',
        'media-key',
        video.contentType,
      );
      expect(video.processingStatus).toBe(VideoProcessingStatus.READY);
      expect(video.durationSeconds).toBe(metadata.durationSeconds);
      expect(video.videoCodec).toBe(metadata.videoCodec);
      expect(video.sizeBytes).toBe(metadata.sizeBytes);
    });

    it('marks the video FAILED with NO_VIDEO_STREAM and throws UnrecoverableError without a local-download fallback', async () => {
      const video = buildVideo();
      videoRepository.findOneBy.mockResolvedValue(video);
      ffmpegService.probe.mockRejectedValue(new NoVideoStreamError());

      await expect(
        processor.process({ data: { videoId: video.id } } as any),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(video.processingStatus).toBe(VideoProcessingStatus.FAILED);
      expect(video.processingError).toEqual({
        code: PROCESSING_ERROR_CODES.NO_VIDEO_STREAM,
        message: expect.any(String),
      });
      expect(storageService.downloadIngestObjectToFile).not.toHaveBeenCalled();
    });

    it('falls back to a local download when the HTTP-range probe fails transiently, then succeeds', async () => {
      const video = buildVideo();
      videoRepository.findOneBy.mockResolvedValue(video);
      ffmpegService.probe
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(metadata);
      ffmpegService.extractThumbnail.mockResolvedValue(thumbnail);

      await processor.process({ data: { videoId: video.id } } as any);

      expect(storageService.downloadIngestObjectToFile).toHaveBeenCalledWith(
        'ingest-key',
        expect.stringContaining(video.id),
      );
      expect(ffmpegService.probe).toHaveBeenCalledTimes(2);
      expect(video.processingStatus).toBe(VideoProcessingStatus.READY);
    });

    it('propagates a transient error that also fails on the local-download fallback, without marking FAILED', async () => {
      const video = buildVideo();
      videoRepository.findOneBy.mockResolvedValue(video);
      ffmpegService.probe.mockRejectedValue(new Error('storage hiccup'));

      await expect(
        processor.process({ data: { videoId: video.id } } as any),
      ).rejects.toThrow('storage hiccup');

      expect(video.processingStatus).toBe(VideoProcessingStatus.PROCESSING);
    });
  });

  describe('onFailed', () => {
    it('does nothing when the error is an UnrecoverableError (already handled by process())', async () => {
      const job = {
        data: { videoId: 'video-1' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      };

      await processor.onFailed(
        job as any,
        new UnrecoverableError('no video stream'),
      );

      expect(videoRepository.findOneBy).not.toHaveBeenCalled();
    });

    it('does nothing while retries remain', async () => {
      const job = {
        data: { videoId: 'video-1' },
        attemptsMade: 1,
        opts: { attempts: 3 },
      };

      await processor.onFailed(job as any, new Error('transient'));

      expect(videoRepository.findOneBy).not.toHaveBeenCalled();
    });

    it('marks the video FAILED with PROCESSING_FAILED once the retry budget is exhausted', async () => {
      const video = buildVideo({
        processingStatus: VideoProcessingStatus.PROCESSING,
      });
      videoRepository.findOneBy.mockResolvedValue(video);
      const job = {
        data: { videoId: video.id },
        attemptsMade: 3,
        opts: { attempts: 3 },
      };

      await processor.onFailed(job as any, new Error('storage down'));

      expect(video.processingStatus).toBe(VideoProcessingStatus.FAILED);
      expect(video.processingError).toEqual({
        code: PROCESSING_ERROR_CODES.PROCESSING_FAILED,
        message: 'storage down',
      });
      expect(videoRepository.save).toHaveBeenCalledWith(video);
    });
  });
});
