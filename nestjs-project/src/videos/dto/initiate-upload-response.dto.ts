import { ApiProperty } from '@nestjs/swagger';

export class InitiateUploadResponseDto {
  @ApiProperty({
    description: 'The S3 UploadId for the opened multipart upload',
  })
  uploadId: string;

  @ApiProperty({
    description: 'The videoId-addressed ingest object key chosen by the API',
  })
  key: string;

  @ApiProperty({
    description:
      'The 11-char public handle used by every subsequent video route',
  })
  publicSlug: string;
}
