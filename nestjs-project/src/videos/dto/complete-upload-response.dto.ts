import { ApiProperty } from '@nestjs/swagger';

export class CompleteUploadResponseDto {
  @ApiProperty({ description: 'The completed object location' })
  location: string;
}
