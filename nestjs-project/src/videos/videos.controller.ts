import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';
import { VideoStatusResponseDto } from './dto/video-status-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Get(':publicSlug')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video status',
    description: "Returns the video's pipeline state and extracted metadata.",
  })
  @ApiResponse({
    status: 200,
    description: 'Video status',
    type: VideoStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'publicSlug matches no video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStatus(
    @CurrentUser() user: JwtPayload,
    @Param('publicSlug') publicSlug: string,
  ): Promise<VideoStatusResponseDto> {
    const video = await this.videosService.getStatus(user.sub, publicSlug);

    return {
      publicSlug: video.publicSlug,
      title: video.title,
      processingStatus: video.processingStatus,
      processingError: video.processingError,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      sizeBytes: video.sizeBytes,
      container: video.container,
      videoCodec: video.videoCodec,
      audioCodec: video.audioCodec,
    };
  }

  @Get(':publicSlug/playback')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a playback URL',
    description:
      'Mints a fresh short-lived presigned GetObject URL for streaming.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned playback URL',
    type: PresignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'publicSlug matches no video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPlaybackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicSlug') publicSlug: string,
  ): Promise<PresignedUrlResponseDto> {
    return this.videosService.getPlaybackUrl(user.sub, publicSlug);
  }

  @Get(':publicSlug/download')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Mints a fresh short-lived presigned GetObject URL with a Content-Disposition override so the browser saves instead of streams.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    type: PresignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'publicSlug matches no video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicSlug') publicSlug: string,
  ): Promise<PresignedUrlResponseDto> {
    return this.videosService.getDownloadUrl(user.sub, publicSlug);
  }
}
