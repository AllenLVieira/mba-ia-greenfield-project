import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingStatus } from '../entities/video.entity';

export class ProcessingErrorDto {
  @ApiProperty({ example: 'NO_VIDEO_STREAM' })
  code: string;

  @ApiProperty({ example: 'The uploaded object contains no video stream' })
  message: string;
}

export class VideoStatusResponseDto {
  @ApiProperty({ description: 'The 11-char public handle for this video' })
  publicSlug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoProcessingStatus })
  processingStatus: VideoProcessingStatus;

  @ApiProperty({
    type: ProcessingErrorDto,
    required: false,
    nullable: true,
  })
  processingError: ProcessingErrorDto | null;

  @ApiProperty({ required: false, nullable: true })
  durationSeconds: number | null;

  @ApiProperty({ required: false, nullable: true })
  width: number | null;

  @ApiProperty({ required: false, nullable: true })
  height: number | null;

  @ApiProperty({ description: 'Declared and reconciled object size, in bytes' })
  sizeBytes: string;

  @ApiProperty({ required: false, nullable: true })
  container: string | null;

  @ApiProperty({ required: false, nullable: true })
  videoCodec: string | null;

  @ApiProperty({ required: false, nullable: true })
  audioCodec: string | null;
}
