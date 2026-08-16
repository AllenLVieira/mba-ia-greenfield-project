import { randomBytes } from 'node:crypto';

const PUBLIC_SLUG_BYTES = 8;

export function generatePublicSlug(): string {
  return randomBytes(PUBLIC_SLUG_BYTES).toString('base64url');
}
