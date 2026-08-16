import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class InitiateUploadDto {
  /** Original filename of the video being uploaded. */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /** Total size of the video file in bytes. */
  @IsInt()
  @IsPositive()
  sizeBytes: number;

  /** MIME type of the video file. */
  @IsString()
  @IsNotEmpty()
  contentType: string;
}
