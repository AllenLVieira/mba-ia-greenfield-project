import { registerAs } from '@nestjs/config';

/**
 * Two endpoints, deliberately (per `phase-03-videos/TD-03`):
 * - `internalEndpoint` is the Compose service name, used for server-side I/O.
 * - `publicEndpoint` is the published host, used to mint presigned URLs the
 *   browser can actually reach — the signature is bound to the host, so a
 *   URL signed against the internal endpoint is invalid outside the network.
 */
export default registerAs('storage', () => ({
  internalEndpoint: process.env.STORAGE_INTERNAL_ENDPOINT!,
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT!,
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
  uploadsBucket: process.env.STORAGE_UPLOADS_BUCKET!,
  mediaBucket: process.env.STORAGE_MEDIA_BUCKET!,
  presignTtlSeconds: parseInt(
    process.env.STORAGE_PRESIGN_TTL_SECONDS || '3600',
    10,
  ),
}));
