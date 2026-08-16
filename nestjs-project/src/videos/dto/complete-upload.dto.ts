import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedUploadPartDto {
  /** ETag returned by object storage for this part's PUT response. */
  @IsString()
  @IsNotEmpty()
  ETag: string;

  /** 1-based part number, matching the part signed via GET .../parts/{partNumber}. */
  @IsInt()
  @Min(1)
  PartNumber: number;
}

export class CompleteUploadDto {
  /** Parts collected by the client from its own PUT responses, in PartNumber order. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedUploadPartDto)
  parts: CompletedUploadPartDto[];
}
