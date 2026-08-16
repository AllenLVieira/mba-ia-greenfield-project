import { ApiProperty } from '@nestjs/swagger';

export class SignPartResponseDto {
  @ApiProperty({
    description: 'Presigned UploadPart URL, signed for the browser',
  })
  url: string;

  @ApiProperty({
    description: 'Headers the client must replay on the PUT',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  headers: Record<string, string>;
}
