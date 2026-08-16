import { UploadPartCommand, type S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import type { MailService } from '../src/mail/mail.service';
import storageConfig from '../src/config/storage.config';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

describe('Videos uploads (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let internalS3: S3Client;
  let uploadsBucket: string;

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
    uploadsBucket = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).uploadsBucket;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    counter += 1;
    const email = `uploader_${counter}_${Date.now()}@example.com`;
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

    return res.body.access_token as string;
  }

  async function openUpload(token: string): Promise<{
    uploadId: string;
    key: string;
    publicSlug: string;
  }> {
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'meu-video.mp4',
        sizeBytes: 1048576,
        contentType: 'video/mp4',
      });
    return res.body;
  }

  describe('POST /videos/uploads', () => {
    it('abre upload e retorna handshake', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'meu-video.mp4',
          sizeBytes: 1048576,
          contentType: 'video/mp4',
        });

      expect(res.status).toBe(201);
      expect(typeof res.body.uploadId).toBe('string');
      expect(res.body.uploadId.length).toBeGreaterThan(0);
      expect(typeof res.body.key).toBe('string');
      expect(res.body.publicSlug).toHaveLength(11);

      const video = await videoRepository.findOne({
        where: { publicSlug: res.body.publicSlug },
      });
      expect(video?.processingStatus).toBe(
        VideoProcessingStatus.PENDING_UPLOAD,
      );
      expect(video?.title).toBe('meu-video');
      expect(video?.originalFilename).toBe('meu-video.mp4');
      expect(video?.contentType).toBe('video/mp4');
      expect(video?.sizeBytes).toBe('1048576');
      expect(video?.uploadId).toBeTruthy();
    });

    it('rejeita corpo inválido', async () => {
      const token = await registerConfirmAndLogin();

      const missingFilename = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ sizeBytes: 1024, contentType: 'video/mp4' });
      expect(missingFilename.status).toBe(400);

      const invalidFields = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ filename: 'x.mp4', sizeBytes: -1, contentType: '' });
      expect(invalidFields.status).toBe(400);

      const count = await videoRepository.count();
      expect(count).toBe(0);
    });
  });

  describe('GET /videos/uploads/{uploadId}/parts/{partNumber}', () => {
    it('rejeita partNumber menor que um', async () => {
      const token = await registerConfirmAndLogin();
      const { uploadId } = await openUpload(token);

      const zero = await request(app.getHttpServer())
        .get(`/videos/uploads/${uploadId}/parts/0`)
        .set('Authorization', `Bearer ${token}`);
      expect(zero.status).toBe(400);

      const negative = await request(app.getHttpServer())
        .get(`/videos/uploads/${uploadId}/parts/-1`)
        .set('Authorization', `Bearer ${token}`);
      expect(negative.status).toBe(400);

      const nonNumeric = await request(app.getHttpServer())
        .get(`/videos/uploads/${uploadId}/parts/abc`)
        .set('Authorization', `Bearer ${token}`);
      expect(nonNumeric.status).toBe(400);

      const video = await videoRepository.findOne({ where: { uploadId } });
      expect(video?.processingStatus).toBe(
        VideoProcessingStatus.PENDING_UPLOAD,
      );
    });

    it('presigna e move para UPLOADING', async () => {
      const token = await registerConfirmAndLogin();
      const { uploadId } = await openUpload(token);

      const first = await request(app.getHttpServer())
        .get(`/videos/uploads/${uploadId}/parts/1`)
        .set('Authorization', `Bearer ${token}`);
      expect(first.status).toBe(200);
      expect(typeof first.body.url).toBe('string');
      expect(typeof first.body.headers).toBe('object');
      expect(first.body.url).not.toContain('minio:9000');

      let video = await videoRepository.findOne({ where: { uploadId } });
      expect(video?.processingStatus).toBe(VideoProcessingStatus.UPLOADING);

      const second = await request(app.getHttpServer())
        .get(`/videos/uploads/${uploadId}/parts/2`)
        .set('Authorization', `Bearer ${token}`);
      expect(second.status).toBe(200);

      video = await videoRepository.findOne({ where: { uploadId } });
      expect(video?.processingStatus).toBe(VideoProcessingStatus.UPLOADING);
    });
  });

  describe('POST /videos/uploads/{uploadId}/complete', () => {
    it('rejeita parts vazio ou malformado', async () => {
      const token = await registerConfirmAndLogin();
      const { uploadId } = await openUpload(token);
      await request(app.getHttpServer())
        .get(`/videos/uploads/${uploadId}/parts/1`)
        .set('Authorization', `Bearer ${token}`);

      const empty = await request(app.getHttpServer())
        .post(`/videos/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [] });
      expect(empty.status).toBe(400);

      const malformed = await request(app.getHttpServer())
        .post(`/videos/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          parts: [{ ETag: 'etag-only' }, { PartNumber: 2 }],
        });
      expect(malformed.status).toBe(400);
    });

    it('retorna 404 UPLOAD_NOT_FOUND para uploadId inexistente', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads/does-not-exist/complete')
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ ETag: 'etag-1', PartNumber: 1 }] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('UPLOAD_NOT_FOUND');
      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 404,
          error: 'UPLOAD_NOT_FOUND',
          message: expect.any(String),
        }),
      );
    });
  });

  describe('DELETE /videos/uploads/{uploadId}', () => {
    it('aborta e invalida o uploadId', async () => {
      const token = await registerConfirmAndLogin();
      const { uploadId } = await openUpload(token);

      const del = await request(app.getHttpServer())
        .delete(`/videos/uploads/${uploadId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(204);
      expect(del.body).toEqual({});

      const video = await videoRepository.findOne({
        where: { originalFilename: 'meu-video.mp4' },
      });
      expect(video?.uploadId).toBeNull();

      const delAgain = await request(app.getHttpServer())
        .delete(`/videos/uploads/${uploadId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(delAgain.status).toBe(404);
      expect(delAgain.body.error).toBe('UPLOAD_NOT_FOUND');

      const completeAfterAbort = await request(app.getHttpServer())
        .post(`/videos/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ ETag: 'etag-1', PartNumber: 1 }] });
      expect(completeAfterAbort.status).toBe(404);
      expect(completeAfterAbort.body.error).toBe('UPLOAD_NOT_FOUND');
    });
  });

  describe('Guards e exposição de identificadores', () => {
    it('sem Authorization retorna 401 em todas as rotas', async () => {
      // JwtAuthGuard (phase-02-auth, global APP_GUARD) throws a plain
      // UnauthorizedException for a missing/invalid bearer token — it does
      // not carry a DomainException errorCode. Matches the existing
      // convention in auth.e2e-spec.ts (e.g. `GET /auth/me` without a
      // header), which only asserts the status code, not the body shape.
      const routes: [string, string][] = [
        ['post', '/videos/uploads'],
        ['get', '/videos/uploads/some-id/parts/1'],
        ['post', '/videos/uploads/some-id/complete'],
        ['delete', '/videos/uploads/some-id'],
      ];

      for (const [method, path] of routes) {
        const res = await (request(app.getHttpServer()) as any)[method](path);
        expect(res.status).toBe(401);
      }

      for (const [method, path] of routes) {
        const res = await (request(app.getHttpServer()) as any)
          [method](path)
          .set('Authorization', 'Bearer malformed-token');
        expect(res.status).toBe(401);
      }
    });

    it('não-dono recebe 403 VIDEO_ACCESS_DENIED', async () => {
      const ownerToken = await registerConfirmAndLogin();
      const otherToken = await registerConfirmAndLogin();
      const { uploadId } = await openUpload(ownerToken);

      const signPart = await request(app.getHttpServer())
        .get(`/videos/uploads/${uploadId}/parts/1`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(signPart.status).toBe(403);
      expect(signPart.body.error).toBe('VIDEO_ACCESS_DENIED');

      const complete = await request(app.getHttpServer())
        .post(`/videos/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ ETag: 'etag-1', PartNumber: 1 }] });
      expect(complete.status).toBe(403);
      expect(complete.body.error).toBe('VIDEO_ACCESS_DENIED');

      const abort = await request(app.getHttpServer())
        .delete(`/videos/uploads/${uploadId}`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(abort.status).toBe(403);
      expect(abort.body.error).toBe('VIDEO_ACCESS_DENIED');

      const video = await videoRepository.findOne({ where: { uploadId } });
      expect(video?.uploadId).toBe(uploadId);
      expect(video?.processingStatus).toBe(
        VideoProcessingStatus.PENDING_UPLOAD,
      );

      const initiateAsOther = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({
          filename: 'outro-video.mp4',
          sizeBytes: 2048,
          contentType: 'video/mp4',
        });
      expect(initiateAsOther.status).toBe(201);
    });

    it('nenhuma resposta expõe o UUID interno do vídeo como identificador', async () => {
      const token = await registerConfirmAndLogin();

      const initiate = await openUpload(token);
      expect(initiate).not.toHaveProperty('id');
      expect(initiate.publicSlug).toHaveLength(11);

      const video = await videoRepository.findOne({
        where: { uploadId: initiate.uploadId },
      });
      const internalId = video?.id as string;
      // `key` legitimately embeds the videoId per the upload protocol
      // (`phase-03-videos/TD-02`) — it's the one documented exception.
      expect(initiate.key).toContain(internalId);

      const signPart = await request(app.getHttpServer())
        .get(`/videos/uploads/${initiate.uploadId}/parts/1`)
        .set('Authorization', `Bearer ${token}`);
      expect(signPart.body).not.toHaveProperty('id');

      const { ETag } = await internalS3.send(
        new UploadPartCommand({
          Bucket: uploadsBucket,
          Key: initiate.key,
          UploadId: initiate.uploadId,
          PartNumber: 1,
          Body: Buffer.from('fake-video-bytes'),
        }),
      );

      const complete = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiate.uploadId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ ETag, PartNumber: 1 }] });
      expect(complete.status).toBe(200);
      expect(complete.body).not.toHaveProperty('id');
      expect(complete.body).toEqual({ location: expect.any(String) });
    });
  });
});
