import { createReadStream, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { FfmpegService } from './ffmpeg.service';
import { NoVideoStreamError } from './ffmpeg.errors';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'test', 'fixtures');

interface ServedFile {
  server: Server;
  url: string;
  size: number;
  bytesServed: () => number;
  rangeRequests: () => number;
  plainRequests: () => number;
}

function serveFile(filePath: string): Promise<ServedFile> {
  const { size } = statSync(filePath);
  let bytesServed = 0;
  let rangeRequests = 0;
  let plainRequests = 0;

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const range = req.headers.range;
      if (range) {
        rangeRequests += 1;
        const [startStr, endStr] = range.replace('bytes=', '').split('-');
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        const stream = createReadStream(filePath, { start, end });
        stream.on('data', (chunk: Buffer) => (bytesServed += chunk.length));
        stream.pipe(res);
        return;
      }
      plainRequests += 1;
      res.writeHead(200, {
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
      });
      const stream = createReadStream(filePath);
      stream.on('data', (chunk: Buffer) => (bytesServed += chunk.length));
      stream.pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/fixture`,
        size,
        bytesServed: () => bytesServed,
        rangeRequests: () => rangeRequests,
        plainRequests: () => plainRequests,
      });
    });
  });
}

describe('FfmpegService (integration)', () => {
  const service = new FfmpegService();
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it('probes a real video fixture over HTTP and extracts duration/dimensions/codecs', async () => {
    const {
      server: s,
      url,
      rangeRequests,
      plainRequests,
    } = await serveFile(join(FIXTURES_DIR, 'sample-video.mp4'));
    server = s;

    const metadata = await service.probe(url);

    expect(metadata.durationSeconds).toBeGreaterThanOrEqual(19);
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(480);
    expect(metadata.videoCodec).toBe('h264');
    expect(metadata.audioCodec).toBe('aac');
    expect(Number(metadata.sizeBytes)).toBeGreaterThan(0);
    // AC: probing drives the read through HTTP Range requests (partial reads),
    // never a full sequential GET — the property that keeps probing a 10GB
    // object cheap. ffprobe issues a `Range: bytes=0-` request and closes the
    // connection once it has the header, so asserting on the transferred byte
    // count is racy (the server may buffer the whole small fixture before the
    // socket closes); asserting on the access *pattern* is deterministic.
    expect(rangeRequests()).toBeGreaterThan(0);
    expect(plainRequests()).toBe(0);
  });

  it('throws NoVideoStreamError for an audio-only fixture', async () => {
    const { server: s, url } = await serveFile(
      join(FIXTURES_DIR, 'sample-audio-only.m4a'),
    );
    server = s;

    await expect(service.probe(url)).rejects.toBeInstanceOf(NoVideoStreamError);
  });

  it('extracts a 1280x720 JPEG thumbnail at 10% of the duration', async () => {
    const { server: s, url } = await serveFile(
      join(FIXTURES_DIR, 'sample-video.mp4'),
    );
    server = s;

    const metadata = await service.probe(url);
    const thumbnail = await service.extractThumbnail(
      url,
      metadata.durationSeconds,
    );

    expect(thumbnail.length).toBeGreaterThan(0);
    expect(thumbnail[0]).toBe(0xff);
    expect(thumbnail[1]).toBe(0xd8);

    const thumbnailPath = join(tmpdir(), `ffmpeg-thumbnail-${Date.now()}.jpg`);
    writeFileSync(thumbnailPath, thumbnail);
    try {
      const dimensions = await service.probe(thumbnailPath);
      expect(dimensions.width).toBe(1280);
      expect(dimensions.height).toBe(720);
    } finally {
      unlinkSync(thumbnailPath);
    }
  });
});
