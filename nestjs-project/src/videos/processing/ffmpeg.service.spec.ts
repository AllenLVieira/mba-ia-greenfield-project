import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { FfmpegService } from './ffmpeg.service';
import { NoVideoStreamError } from './ffmpeg.errors';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const mockedSpawn = spawn as unknown as jest.Mock;

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function emitSuccess(child: FakeChildProcess, stdout: string): void {
  child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', 0);
}

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(() => {
    service = new FfmpegService();
    mockedSpawn.mockReset();
  });

  describe('probe', () => {
    it('parses ffprobe JSON output into VideoMetadata', async () => {
      const child = new FakeChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.probe('http://example.com/video.mp4');
      emitSuccess(
        child,
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 1920,
              height: 1080,
            },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
          format: {
            duration: '125.5',
            size: '104857600',
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          },
        }),
      );

      const metadata = await promise;

      expect(metadata).toEqual({
        durationSeconds: 126,
        width: 1920,
        height: 1080,
        sizeBytes: '104857600',
        container: 'mov',
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
      expect(mockedSpawn).toHaveBeenCalledWith('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'http://example.com/video.mp4',
      ]);
    });

    it('sets audioCodec to null when there is no audio stream', async () => {
      const child = new FakeChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.probe('http://example.com/video.mp4');
      emitSuccess(
        child,
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 320,
              height: 240,
            },
          ],
          format: { duration: '1.0', size: '1000', format_name: 'mp4' },
        }),
      );

      const metadata = await promise;

      expect(metadata.audioCodec).toBeNull();
    });

    it('throws NoVideoStreamError when ffprobe reports no video stream', async () => {
      const child = new FakeChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.probe('http://example.com/audio-only.m4a');
      emitSuccess(
        child,
        JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: 'aac' }],
          format: { duration: '1.0', size: '1000', format_name: 'm4a' },
        }),
      );

      await expect(promise).rejects.toBeInstanceOf(NoVideoStreamError);
      await expect(
        promise.catch((error: NoVideoStreamError) => error.code),
      ).resolves.toBe('NO_VIDEO_STREAM');
    });

    it('rejects when ffprobe exits with a non-zero code', async () => {
      const child = new FakeChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.probe('http://example.com/broken.mp4');
      child.stderr.emit('data', Buffer.from('invalid data found'));
      child.emit('close', 1);

      await expect(promise).rejects.toThrow(/exited with code 1/);
    });
  });

  describe('extractThumbnail', () => {
    it('seeks to 10% of the duration and returns the JPEG bytes', async () => {
      const child = new FakeChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.extractThumbnail(
        'http://example.com/video.mp4',
        200,
      );
      emitSuccess(child, 'jpeg-bytes');

      const thumbnail = await promise;

      expect(thumbnail.toString()).toBe('jpeg-bytes');
      expect(mockedSpawn).toHaveBeenCalledWith('ffmpeg', [
        '-ss',
        '20.000',
        '-i',
        'http://example.com/video.mp4',
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:720',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        '-',
      ]);
    });
  });
});
