import { ApiProperty } from '@nestjs/swagger';

export class PresignedUrlResponseDto {
  @ApiProperty({
    description: 'Presigned GetObject URL against the media bucket',
  })
  url: string;

  @ApiProperty({ description: 'TTL of the presigned URL, in seconds' })
  expiresIn: number;
}
