import { PROCESSING_ERROR_CODES } from '../processing-error-code';

export class NoVideoStreamError extends Error {
  readonly code = PROCESSING_ERROR_CODES.NO_VIDEO_STREAM;

  constructor() {
    super('ffprobe reported no video stream in the input');
    this.name = this.constructor.name;
  }
}
