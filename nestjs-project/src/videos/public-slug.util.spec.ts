import { generatePublicSlug } from './public-slug.util';

describe('generatePublicSlug', () => {
  it('should generate a slug of exactly 11 characters', () => {
    expect(generatePublicSlug()).toHaveLength(11);
  });

  it('should only contain base64url alphabet characters', () => {
    const slug = generatePublicSlug();

    expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should not collide across a large sample', () => {
    const sampleSize = 100_000;
    const slugs = new Set<string>();

    for (let i = 0; i < sampleSize; i += 1) {
      slugs.add(generatePublicSlug());
    }

    expect(slugs.size).toBe(sampleSize);
  });
});
