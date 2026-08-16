import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicSlug } from '../public-slug.util';
import { Video, VideoProcessingStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function baseVideoData(channelId: string) {
    return {
      publicSlug: generatePublicSlug(),
      title: 'My Video',
      channelId,
      originalFilename: 'my-video.mp4',
      contentType: 'video/mp4',
      sizeBytes: '1048576',
    };
  }

  it('should violate the UNIQUE constraint when two videos share the same publicSlug', async () => {
    const channel = await createChannel();
    const sharedSlug = generatePublicSlug();

    await videoRepository.save(
      videoRepository.create({
        ...baseVideoData(channel.id),
        publicSlug: sharedSlug,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          ...baseVideoData(channel.id),
          publicSlug: sharedSlug,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default processingStatus to PENDING_UPLOAD when not provided explicitly', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(baseVideoData(channel.id)),
    );

    expect(video.processingStatus).toBe(VideoProcessingStatus.PENDING_UPLOAD);
  });

  it('should allow ffprobe-derived metadata columns to be null before processing completes', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        ...baseVideoData(channel.id),
        durationSeconds: null,
        width: null,
        height: null,
        container: null,
        videoCodec: null,
        audioCodec: null,
      }),
    );

    expect(video.durationSeconds).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.container).toBeNull();
    expect(video.videoCodec).toBeNull();
    expect(video.audioCodec).toBeNull();
  });

  it.each([
    ['channelId', { channelId: undefined }],
    ['title', { title: undefined }],
    ['originalFilename', { originalFilename: undefined }],
    ['contentType', { contentType: undefined }],
    ['sizeBytes', { sizeBytes: undefined }],
  ])(
    'should reject a video missing required field %s',
    async (_field, overrides) => {
      const channel = await createChannel();

      await expect(
        videoRepository.save(
          videoRepository.create({
            ...baseVideoData(channel.id),
            ...overrides,
          }),
        ),
      ).rejects.toThrow();
    },
  );

  it('should enforce the FK constraint on channelId', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create(
          baseVideoData('00000000-0000-0000-0000-000000000000'),
        ),
      ),
    ).rejects.toThrow();
  });
});
