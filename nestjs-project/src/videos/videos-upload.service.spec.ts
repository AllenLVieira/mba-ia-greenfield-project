import { VideosUploadService } from './videos-upload.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  InvalidUploadStateException,
  UploadNotFoundException,
  VideoAccessDeniedException,
} from '../common/exceptions/domain.exception';

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-id';
  video.publicSlug = 'abcdefghijk';
  video.title = 'My Video';
  video.channelId = 'channel-id';
  video.processingStatus = VideoProcessingStatus.PENDING_UPLOAD;
  video.processingError = null;
  video.originalFilename = 'my-video.mp4';
  video.contentType = 'video/mp4';
  video.sizeBytes = '1048576';
  video.uploadId = 'upload-id';
  video.durationSeconds = null;
  video.width = null;
  video.height = null;
  video.container = null;
  video.videoCodec = null;
  video.audioCodec = null;
  video.created_at = new Date();
  video.updated_at = new Date();
  return Object.assign(video, overrides);
}

function makeVideoRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    create: jest.fn((data: any) => Object.assign(new Video(), data)),
    save: jest.fn(async (v: Video) => v),
    findOne: jest.fn(),
    ...overrides,
  };
}

function makeStorageService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    getIngestKey: jest.fn(
      (videoId: string, ext: string) => `${videoId}/source${ext}`,
    ),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    presignUploadPart: jest.fn().mockResolvedValue('https://signed-url'),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeChannelsService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findByUserId: jest.fn().mockResolvedValue({ id: 'channel-id' }),
    ...overrides,
  };
}

function makeQueue(overrides: Record<string, jest.Mock> = {}): any {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('VideosUploadService', () => {
  describe('initiate', () => {
    it('creates a video in PENDING_UPLOAD with title derived from the filename without extension', async () => {
      const videoRepository = makeVideoRepository();
      const storageService = makeStorageService();
      const channelsService = makeChannelsService();
      const queue = makeQueue();
      const service = new VideosUploadService(
        videoRepository,
        storageService,
        channelsService,
        queue,
      );

      const result = await service.initiate('user-id', {
        filename: 'my-video.mp4',
        sizeBytes: 1024,
        contentType: 'video/mp4',
      });

      expect(result.video.title).toBe('my-video');
      expect(result.video.channelId).toBe('channel-id');
      expect(result.video.processingStatus).toBe(
        VideoProcessingStatus.PENDING_UPLOAD,
      );
      expect(result.video.uploadId).toBe('upload-id');
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringContaining('/source.mp4'),
        'video/mp4',
      );
    });
  });

  describe('signPart', () => {
    it('transitions PENDING_UPLOAD to UPLOADING on the first signed part', async () => {
      const video = makeVideo({
        processingStatus: VideoProcessingStatus.PENDING_UPLOAD,
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const storageService = makeStorageService();
      const channelsService = makeChannelsService();
      const queue = makeQueue();
      const service = new VideosUploadService(
        videoRepository,
        storageService,
        channelsService,
        queue,
      );

      await service.signPart('user-id', 'upload-id', 1);

      expect(video.processingStatus).toBe(VideoProcessingStatus.UPLOADING);
      expect(videoRepository.save).toHaveBeenCalled();
    });

    it('does not change status when signing subsequent parts while UPLOADING', async () => {
      const video = makeVideo({
        processingStatus: VideoProcessingStatus.UPLOADING,
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const storageService = makeStorageService();
      const channelsService = makeChannelsService();
      const queue = makeQueue();
      const service = new VideosUploadService(
        videoRepository,
        storageService,
        channelsService,
        queue,
      );

      await service.signPart('user-id', 'upload-id', 2);

      expect(video.processingStatus).toBe(VideoProcessingStatus.UPLOADING);
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('throws UPLOAD_NOT_FOUND when uploadId matches no video', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosUploadService(
        videoRepository,
        makeStorageService(),
        makeChannelsService(),
        makeQueue(),
      );

      await expect(
        service.signPart('user-id', 'missing-upload-id', 1),
      ).rejects.toThrow(UploadNotFoundException);
    });

    it('throws VIDEO_ACCESS_DENIED when the caller does not own the video', async () => {
      const video = makeVideo({ channelId: 'other-channel' });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const channelsService = makeChannelsService({
        findByUserId: jest.fn().mockResolvedValue({ id: 'channel-id' }),
      });
      const service = new VideosUploadService(
        videoRepository,
        makeStorageService(),
        channelsService,
        makeQueue(),
      );

      await expect(service.signPart('user-id', 'upload-id', 1)).rejects.toThrow(
        VideoAccessDeniedException,
      );
    });

    it('throws INVALID_UPLOAD_STATE when the video is no longer PENDING_UPLOAD or UPLOADING', async () => {
      const video = makeVideo({
        processingStatus: VideoProcessingStatus.READY,
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosUploadService(
        videoRepository,
        makeStorageService(),
        makeChannelsService(),
        makeQueue(),
      );

      await expect(service.signPart('user-id', 'upload-id', 1)).rejects.toThrow(
        InvalidUploadStateException,
      );
    });
  });

  describe('complete', () => {
    it('enqueues exactly one process-video job keyed by the video id, orders parts, and clears uploadId', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const storageService = makeStorageService();
      const queue = makeQueue();
      const service = new VideosUploadService(
        videoRepository,
        storageService,
        makeChannelsService(),
        queue,
      );

      const result = await service.complete('user-id', 'upload-id', [
        { ETag: 'etag-2', PartNumber: 2 },
        { ETag: 'etag-1', PartNumber: 1 },
      ]);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        expect.any(String),
        'upload-id',
        [
          { ETag: 'etag-1', PartNumber: 1 },
          { ETag: 'etag-2', PartNumber: 2 },
        ],
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: video.id },
        { jobId: video.id },
      );
      expect(result.video.uploadId).toBeNull();
    });

    it('throws INVALID_UPLOAD_STATE when the video is not in PENDING_UPLOAD or UPLOADING', async () => {
      const video = makeVideo({
        processingStatus: VideoProcessingStatus.FAILED,
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosUploadService(
        videoRepository,
        makeStorageService(),
        makeChannelsService(),
        makeQueue(),
      );

      await expect(
        service.complete('user-id', 'upload-id', [
          { ETag: 'etag-1', PartNumber: 1 },
        ]),
      ).rejects.toThrow(InvalidUploadStateException);
    });
  });

  describe('abort', () => {
    it('clears the uploadId so subsequent calls treat it as not found', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const storageService = makeStorageService();
      const service = new VideosUploadService(
        videoRepository,
        storageService,
        makeChannelsService(),
        makeQueue(),
      );

      await service.abort('user-id', 'upload-id');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.any(String),
        'upload-id',
      );
      expect(video.uploadId).toBeNull();
    });

    it('throws VIDEO_ACCESS_DENIED when the caller does not own the video', async () => {
      const video = makeVideo({ channelId: 'other-channel' });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosUploadService(
        videoRepository,
        makeStorageService(),
        makeChannelsService(),
        makeQueue(),
      );

      await expect(service.abort('user-id', 'upload-id')).rejects.toThrow(
        VideoAccessDeniedException,
      );
    });
  });
});
