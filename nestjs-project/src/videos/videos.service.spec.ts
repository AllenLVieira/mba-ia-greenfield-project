import { VideosService } from './videos.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-id';
  video.publicSlug = 'abcdefghijk';
  video.title = 'My Video';
  video.channelId = 'channel-id';
  video.processingStatus = VideoProcessingStatus.READY;
  video.processingError = null;
  video.originalFilename = 'my-video.mp4';
  video.contentType = 'video/mp4';
  video.sizeBytes = '1048576';
  video.uploadId = null;
  video.durationSeconds = 42;
  video.width = 1920;
  video.height = 1080;
  video.container = 'mov';
  video.videoCodec = 'h264';
  video.audioCodec = 'aac';
  video.created_at = new Date();
  video.updated_at = new Date();
  return Object.assign(video, overrides);
}

function makeVideoRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findOne: jest.fn(),
    ...overrides,
  };
}

function makeStorageService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    getMediaKey: jest.fn(
      (videoId: string, ext: string) => `videos/${videoId}/video${ext}`,
    ),
    presignMediaGetObject: jest.fn().mockResolvedValue('https://signed-url'),
    ...overrides,
  };
}

function makeChannelsService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findByUserId: jest.fn().mockResolvedValue({ id: 'channel-id' }),
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return { presignTtlSeconds: 3600, ...overrides };
}

describe('VideosService', () => {
  describe('ownership branches', () => {
    it('throws VideoNotFoundException when publicSlug matches no video', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosService(
        videoRepository,
        makeStorageService(),
        makeChannelsService(),
        makeConfig(),
      );

      await expect(
        service.getStatus('user-id', 'missing-slug'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException when the caller channel does not own the video', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest
          .fn()
          .mockResolvedValue(makeVideo({ channelId: 'other-channel' })),
      });
      const service = new VideosService(
        videoRepository,
        makeStorageService(),
        makeChannelsService(),
        makeConfig(),
      );

      await expect(
        service.getStatus('user-id', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoAccessDeniedException);
    });

    it('throws VideoAccessDeniedException when the caller has no channel', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(makeVideo()),
      });
      const service = new VideosService(
        videoRepository,
        makeStorageService(),
        makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(null),
        }),
        makeConfig(),
      );

      await expect(
        service.getStatus('user-id', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoAccessDeniedException);
    });
  });

  describe('READY gate for playback and download', () => {
    it.each([
      VideoProcessingStatus.PENDING_UPLOAD,
      VideoProcessingStatus.UPLOADING,
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.FAILED,
    ])(
      'blocks playback with VideoNotReadyException when status is %s',
      async (status) => {
        const videoRepository = makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ processingStatus: status })),
        });
        const service = new VideosService(
          videoRepository,
          makeStorageService(),
          makeChannelsService(),
          makeConfig(),
        );

        await expect(
          service.getPlaybackUrl('user-id', 'abcdefghijk'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
      },
    );

    it('blocks download when the video is not READY', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest
          .fn()
          .mockResolvedValue(
            makeVideo({ processingStatus: VideoProcessingStatus.PROCESSING }),
          ),
      });
      const service = new VideosService(
        videoRepository,
        makeStorageService(),
        makeChannelsService(),
        makeConfig(),
      );

      await expect(
        service.getDownloadUrl('user-id', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });
  });

  describe('presigned URL TTL and Content-Disposition', () => {
    it('mints a playback URL with the configured explicit TTL', async () => {
      const storageService = makeStorageService();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(makeVideo()),
      });
      const service = new VideosService(
        videoRepository,
        storageService,
        makeChannelsService(),
        makeConfig({ presignTtlSeconds: 300 }),
      );

      const result = await service.getPlaybackUrl('user-id', 'abcdefghijk');

      expect(result.expiresIn).toBe(300);
      expect(result.expiresIn).not.toBe(900);
      expect(storageService.presignMediaGetObject).toHaveBeenCalledWith(
        'videos/video-id/video.mp4',
        300,
      );
    });

    it('mints a download URL with Content-Disposition derived from originalFilename', async () => {
      const storageService = makeStorageService();
      const videoRepository = makeVideoRepository({
        findOne: jest
          .fn()
          .mockResolvedValue(
            makeVideo({ originalFilename: 'vacation-clip.mp4' }),
          ),
      });
      const service = new VideosService(
        videoRepository,
        storageService,
        makeChannelsService(),
        makeConfig({ presignTtlSeconds: 300 }),
      );

      const result = await service.getDownloadUrl('user-id', 'abcdefghijk');

      expect(result.expiresIn).toBe(300);
      expect(storageService.presignMediaGetObject).toHaveBeenCalledWith(
        'videos/video-id/video.mp4',
        300,
        'attachment; filename="vacation-clip.mp4"',
      );
    });
  });
});
