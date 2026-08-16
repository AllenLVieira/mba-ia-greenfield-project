import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { NoVideoStreamError } from './ffmpeg.errors';

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  sizeBytes: string;
  container: string;
  videoCodec: string;
  audioCodec: string | null;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

interface FfprobeFormat {
  duration: string;
  size: string;
  format_name: string;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

function runFfmpegProcess(
  command: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdoutChunks: Buffer[] = [];
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      if (code !== 0) {
        reject(
          new Error(`${command} exited with code ${code}: ${stderr.trim()}`),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

@Injectable()
export class FfmpegService {
  async probe(url: string): Promise<VideoMetadata> {
    const { stdout } = await runFfmpegProcess('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);

    const output = JSON.parse(stdout.toString('utf-8')) as FfprobeOutput;
    const videoStream = output.streams.find(
      (stream) => stream.codec_type === 'video',
    );
    if (
      !videoStream ||
      videoStream.width == null ||
      videoStream.height == null
    ) {
      throw new NoVideoStreamError();
    }
    const audioStream = output.streams.find(
      (stream) => stream.codec_type === 'audio',
    );

    return {
      durationSeconds: Math.round(parseFloat(output.format.duration)),
      width: videoStream.width,
      height: videoStream.height,
      sizeBytes: output.format.size,
      container: output.format.format_name.split(',')[0],
      videoCodec: videoStream.codec_name,
      audioCodec: audioStream?.codec_name ?? null,
    };
  }

  async extractThumbnail(
    url: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const timestampSeconds = durationSeconds * 0.1;
    const { stdout } = await runFfmpegProcess('ffmpeg', [
      '-ss',
      timestampSeconds.toFixed(3),
      '-i',
      url,
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
    return stdout;
  }
}
