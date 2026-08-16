import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { SignPartParamsDto } from './dto/sign-part-params.dto';
import { SignPartResponseDto } from './dto/sign-part-response.dto';
import { VideoOwnerGuard } from './guards/video-owner.guard';
import { VideosUploadService } from './videos-upload.service';

@ApiTags('videos')
@Controller('videos/uploads')
export class VideosUploadController {
  constructor(private readonly videosUploadService: VideosUploadService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and opens the S3 multipart upload.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const { video, key } = await this.videosUploadService.initiate(
      user.sub,
      dto,
    );

    return {
      uploadId: video.uploadId as string,
      key,
      publicSlug: video.publicSlug,
    };
  }

  @Get(':uploadId/parts/:partNumber')
  @UseGuards(VideoOwnerGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Presign an upload part',
    description:
      'Presigns a single UploadPart request. Transitions the video to UPLOADING on the first part.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URL',
    type: SignPartResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own the video behind uploadId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'uploadId matches no open upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is no longer PENDING_UPLOAD or UPLOADING',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signPart(
    @CurrentUser() user: JwtPayload,
    @Param() params: SignPartParamsDto,
  ): Promise<SignPartResponseDto> {
    const url = await this.videosUploadService.signPart(
      user.sub,
      params.uploadId,
      params.partNumber,
    );

    return { url, headers: {} };
  }

  @Post(':uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(VideoOwnerGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Finalizes the multipart upload and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own the video behind uploadId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'uploadId matches no open upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is no longer PENDING_UPLOAD or UPLOADING',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('uploadId') uploadId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const { location } = await this.videosUploadService.complete(
      user.sub,
      uploadId,
      dto.parts,
    );

    return { location };
  }

  @Delete(':uploadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(VideoOwnerGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a multipart upload',
    description: 'Aborts the multipart upload, releasing the incomplete parts.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own the video behind uploadId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'uploadId matches no open upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param('uploadId') uploadId: string,
  ): Promise<void> {
    await this.videosUploadService.abort(user.sub, uploadId);
  }
}
