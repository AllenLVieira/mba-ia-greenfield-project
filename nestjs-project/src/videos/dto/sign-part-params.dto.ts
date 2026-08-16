import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class SignPartParamsDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  /** 1-based part number (`@uppy/aws-s3` sends 1-based part numbers, never zero). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partNumber: number;
}
