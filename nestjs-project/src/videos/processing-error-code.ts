export const PROCESSING_ERROR_CODES = {
  NO_VIDEO_STREAM: 'NO_VIDEO_STREAM',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;

export type ProcessingErrorCode =
  (typeof PROCESSING_ERROR_CODES)[keyof typeof PROCESSING_ERROR_CODES];

export interface ProcessingError {
  code: ProcessingErrorCode;
  message: string;
}
