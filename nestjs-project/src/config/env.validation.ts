import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  // Object storage (MinIO / S3). The internal endpoint must be the Compose
  // service name — never localhost (per CLAUDE.md § Docker Networking).
  // Scheme is pinned: a bare `host:port` is a syntactically valid URI to Joi
  // (scheme `host`, path `port`), but the S3 client needs an absolute HTTP URL.
  STORAGE_INTERNAL_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  STORAGE_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: Joi.string().required(),
  STORAGE_SECRET_ACCESS_KEY: Joi.string().required(),
  STORAGE_UPLOADS_BUCKET: Joi.string().required(),
  STORAGE_MEDIA_BUCKET: Joi.string().required(),
  STORAGE_PRESIGN_TTL_SECONDS: Joi.number().positive().default(3600),
  // Queue (BullMQ on the PostgreSQL backend — per phase-03-videos/TD-01).
  // No dedicated credentials: it reuses DB_* and only needs its own schema
  // namespace to keep queue tables out of the application's tables.
  QUEUE_SCHEMA: Joi.string().default('bullmq'),
});
