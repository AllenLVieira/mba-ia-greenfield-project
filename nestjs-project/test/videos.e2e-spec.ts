import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import type { MailService } from '../src/mail/mail.service';
import storageConfig from '../src/config/storage.config';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { buildSwaggerDocument } from '../src/swagger/swagger-document';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

describe('Videos status, playback e download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let internalS3: S3Client;
  let storageService: StorageService;
  let mediaBucket: string;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getQueueToken('video'))
      .useValue({ add: jest.fn().mockResolvedValue({}) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    internalS3 = moduleFixture.get<S3Client>(S3_INTERNAL_CLIENT);
    storageService = moduleFixture.get(StorageService);
    mediaBucket = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).mediaBucket;
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let counter = 0;
  async function registerConfirmAndLogin(): Promise<{
    token: string;
    email: string;
  }> {
    counter += 1;
    const email = `viewer_${counter}_${Date.now()}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return { token: res.body.access_token as string, email };
  }

  async function seedVideo(
    user: { token: string; email: string },
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    // Resolve the owning channel the same way VideosService does: through
    // the authenticated user's session — looked up directly in the DB
    // (no extra HTTP round trip, which would otherwise trip auth's
    // rate limiter across a suite this size).
    const owner = await dataSource.manager.findOneOrFail(User, {
      where: { email: user.email },
    });
    const channel = await dataSource.manager.findOneOrFail(Channel, {
      where: { user_id: owner.id },
    });

    counter += 1;
    return videoRepository.save(
      videoRepository.create({
        publicSlug: `vslug${counter}`.padEnd(11, '0').slice(0, 11),
        title: 'My Video',
        channelId: channel.id,
        processingStatus: VideoProcessingStatus.PENDING_UPLOAD,
        originalFilename: 'my-video.mp4',
        contentType: 'video/mp4',
        sizeBytes: '2048',
        ...overrides,
      }),
    );
  }

  async function seedReadyVideoWithMediaObject(
    user: { token: string; email: string },
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const video = await seedVideo(user, {
      processingStatus: VideoProcessingStatus.READY,
      durationSeconds: 42,
      width: 1920,
      height: 1080,
      container: 'mov',
      videoCodec: 'h264',
      audioCodec: 'aac',
      ...overrides,
    });

    const key = storageService.getMediaKey(video.id, '.mp4');
    await internalS3.send(
      new PutObjectCommand({
        Bucket: mediaBucket,
        Key: key,
        Body: Buffer.from('fake-media-bytes'),
        ContentType: video.contentType,
      }),
    );

    return video;
  }

  describe('GET /videos/{publicSlug}', () => {
    it('retorna metadados e nulos antes de READY', async () => {
      const user = await registerConfirmAndLogin();
      const processing = await seedVideo(user, {
        processingStatus: VideoProcessingStatus.PROCESSING,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${processing.publicSlug}`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(200);
      expect(res.body.processingStatus).toBe('PROCESSING');
      expect(res.body.processingError).toBeNull();
      expect(res.body.durationSeconds).toBeNull();
      expect(res.body.width).toBeNull();
      expect(res.body.height).toBeNull();
      expect(res.body.container).toBeNull();
      expect(res.body.videoCodec).toBeNull();
      expect(res.body.audioCodec).toBeNull();
      expect(res.body.publicSlug).toBe(processing.publicSlug);
      expect(res.body.title).toBe(processing.title);
      expect(res.body.sizeBytes).toBe(processing.sizeBytes);
      expect(res.body).not.toHaveProperty('id');
    });

    it('retorna metadados preenchidos quando READY', async () => {
      const user = await registerConfirmAndLogin();
      const ready = await seedReadyVideoWithMediaObject(user);

      const res = await request(app.getHttpServer())
        .get(`/videos/${ready.publicSlug}`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(200);
      expect(res.body.durationSeconds).toBe(42);
      expect(res.body.width).toBe(1920);
      expect(res.body.height).toBe(1080);
      expect(res.body.container).toBe('mov');
      expect(res.body.videoCodec).toBe('h264');
      expect(res.body.audioCodec).toBe('aac');
    });

    it('retorna processingError no formato {code, message} quando FAILED', async () => {
      const user = await registerConfirmAndLogin();
      const failed = await seedVideo(user, {
        processingStatus: VideoProcessingStatus.FAILED,
        processingError: {
          code: 'NO_VIDEO_STREAM',
          message: 'No video stream',
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${failed.publicSlug}`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(200);
      expect(res.body.processingStatus).toBe('FAILED');
      expect(res.body.processingError).toEqual({
        code: 'NO_VIDEO_STREAM',
        message: 'No video stream',
      });
    });

    it('retorna 404 VIDEO_NOT_FOUND para slug inexistente', async () => {
      const user = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .get('/videos/nao-existe1')
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('retorna 403 VIDEO_ACCESS_DENIED para vídeo de outro dono e não vaza metadados', async () => {
      const owner = await registerConfirmAndLogin();
      const other = await registerConfirmAndLogin();
      const video = await seedVideo(owner);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicSlug}`)
        .set('Authorization', `Bearer ${other.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('VIDEO_ACCESS_DENIED');
      expect(res.body).not.toHaveProperty('title');
      expect(res.body).not.toHaveProperty('processingStatus');
    });

    it('sem Authorization retorna 401 nas três rotas', async () => {
      const user = await registerConfirmAndLogin();
      const video = await seedReadyVideoWithMediaObject(user);

      const routes = [
        `/videos/${video.publicSlug}`,
        `/videos/${video.publicSlug}/playback`,
        `/videos/${video.publicSlug}/download`,
      ];

      for (const path of routes) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
      }
    });
  });

  describe('GET /videos/{publicSlug}/playback', () => {
    it.each([
      VideoProcessingStatus.PENDING_UPLOAD,
      VideoProcessingStatus.UPLOADING,
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.FAILED,
    ])('retorna 409 VIDEO_NOT_READY quando status é %s', async (status) => {
      const user = await registerConfirmAndLogin();
      const video = await seedVideo(user, { processingStatus: status });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicSlug}/playback`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    // The public storage endpoint (STORAGE_PUBLIC_ENDPOINT=http://localhost:9000)
    // is unreachable from inside the nestjs-api container (confirmed live,
    // same constraint already documented in SI-03.5/SI-03.6). We therefore
    // assert the URL's shape/host/query contract here — the object's real
    // partial-content support against MinIO is exercised via the internal
    // client, which is the same underlying storage engine.
    it('URL de playback tem TTL explícito, host público, bucket de mídia e a chave suporta Range', async () => {
      const user = await registerConfirmAndLogin();
      const video = await seedReadyVideoWithMediaObject(user);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicSlug}/playback`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.url).toBe('string');
      expect(typeof res.body.expiresIn).toBe('number');
      expect(res.body.expiresIn).not.toBe(900);
      expect(res.body.url).not.toContain('minio:9000');
      expect(res.body.url).toContain(`/${mediaBucket}/`);
      expect(res.body.url).toContain(
        storageService.getMediaKey(video.id, '.mp4'),
      );

      const key = storageService.getMediaKey(video.id, '.mp4');
      const rangeResult = await internalS3.send(
        new GetObjectCommand({
          Bucket: mediaBucket,
          Key: key,
          Range: 'bytes=0-3',
        }),
      );
      expect(rangeResult.ContentRange).toContain('bytes 0-3');
    });

    it('a URL nova é distinta da anterior a cada chamada', async () => {
      const user = await registerConfirmAndLogin();
      const video = await seedReadyVideoWithMediaObject(user);

      const first = await request(app.getHttpServer())
        .get(`/videos/${video.publicSlug}/playback`)
        .set('Authorization', `Bearer ${user.token}`);
      // SigV4 presigned URLs are deterministic within the same X-Amz-Date
      // second (bucket + key + TTL + date → same signature); a real gap is
      // needed to prove each call mints a fresh URL, not a cached one.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const second = await request(app.getHttpServer())
        .get(`/videos/${video.publicSlug}/playback`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(second.body.url).not.toBe(first.body.url);
    });
  });

  describe('GET /videos/{publicSlug}/download', () => {
    it('URL de download carrega response-content-disposition assinado e nome original', async () => {
      const user = await registerConfirmAndLogin();
      const video = await seedReadyVideoWithMediaObject(user, {
        originalFilename: 'vacation-clip.mp4',
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicSlug}/download`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.expiresIn).toBe('number');
      const url = new URL(res.body.url);
      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="vacation-clip.mp4"',
      );
    });

    it('retorna 409 VIDEO_NOT_READY quando o vídeo não está READY', async () => {
      const user = await registerConfirmAndLogin();
      const video = await seedVideo(user, {
        processingStatus: VideoProcessingStatus.PROCESSING,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicSlug}/download`)
        .set('Authorization', `Bearer ${user.token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('Contrato OpenAPI publicado', () => {
    it('descreve as sete rotas da fase e bate com o documento gerado em runtime', async () => {
      const committed = JSON.parse(
        readFileSync(join(__dirname, '..', 'openapi.json'), 'utf-8'),
      );

      const expectedPaths = [
        '/videos/uploads',
        '/videos/uploads/{uploadId}/parts/{partNumber}',
        '/videos/uploads/{uploadId}/complete',
        '/videos/uploads/{uploadId}',
        '/videos/{publicSlug}',
        '/videos/{publicSlug}/playback',
        '/videos/{publicSlug}/download',
      ];
      for (const path of expectedPaths) {
        expect(committed.paths).toHaveProperty(path);
      }

      const runtimeDocument = buildSwaggerDocument(app);

      for (const path of expectedPaths) {
        expect(runtimeDocument.paths).toHaveProperty(path);
      }
    });
  });
});
