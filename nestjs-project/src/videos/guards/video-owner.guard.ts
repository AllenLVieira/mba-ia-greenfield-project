import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../../auth/auth.types';
import { VideosUploadService } from '../videos-upload.service';

@Injectable()
export class VideoOwnerGuard implements CanActivate {
  constructor(private readonly videosUploadService: VideosUploadService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user: JwtPayload; params: { uploadId: string } }
      >();
    const { uploadId } = request.params;

    if (request.method === 'DELETE') {
      await this.videosUploadService.assertOwnershipOnly(
        request.user.sub,
        uploadId,
      );
    } else {
      await this.videosUploadService.assertOwnership(
        request.user.sub,
        uploadId,
      );
    }

    return true;
  }
}
