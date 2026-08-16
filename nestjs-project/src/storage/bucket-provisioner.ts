import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './storage.constants';

const INCOMPLETE_MULTIPART_EXPIRATION_DAYS = 1;

@Injectable()
export class BucketProvisioner implements OnModuleInit {
  private readonly logger = new Logger(BucketProvisioner.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly s3: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket(this.config.uploadsBucket);
    await this.ensureBucket(this.config.mediaBucket);
    await this.applyUploadsBucketPolicies();
  }

  private async ensureBucket(bucket: string): Promise<void> {
    const exists = await this.bucketExists(bucket);
    if (exists) {
      return;
    }

    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (error instanceof BucketAlreadyOwnedByYou) {
        return;
      }
      throw error;
    }
  }

  private async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch {
      return false;
    }
  }

  private async applyUploadsBucketPolicies(): Promise<void> {
    await this.putUploadsBucketCors();
    await this.putIncompleteMultipartLifecycleRule();
  }

  /**
   * MinIO does not implement PutBucketCors/DeleteBucketCors — CORS is enabled
   * by default on every bucket for every HTTP verb there, so the call always
   * fails with `NotImplemented` (501) against it. Against real S3 the same
   * call is required and must succeed, so the error is tolerated only for
   * that specific, known-safe backend limitation.
   */
  private async putUploadsBucketCors(): Promise<void> {
    try {
      await this.s3.send(
        new PutBucketCorsCommand({
          Bucket: this.config.uploadsBucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedMethods: ['PUT', 'GET'],
                AllowedOrigins: ['*'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
              },
            ],
          },
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'NotImplemented') {
        return;
      }
      throw error;
    }
  }

  /**
   * MinIO rejects `AbortIncompleteMultipartUpload` inside PutBucketLifecycle
   * (`InvalidArgument`) — the action is documented as unsupported there, and,
   * unlike CORS, MinIO has no equivalent automatic behavior standing in for
   * it. On MinIO, abandoned multipart uploads are only cleaned up by a manual
   * `mc rm --incomplete` sweep — never automatically. Against real S3 the
   * same call is required and must succeed, so the error is tolerated only
   * for this specific, known MinIO limitation, with a startup warning.
   */
  private async putIncompleteMultipartLifecycleRule(): Promise<void> {
    try {
      await this.s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.config.uploadsBucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-multipart-uploads',
                Status: 'Enabled',
                Filter: {},
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: INCOMPLETE_MULTIPART_EXPIRATION_DAYS,
                },
              },
            ],
          },
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidArgument') {
        this.logger.warn(
          'MinIO does not support the AbortIncompleteMultipartUpload lifecycle action; incomplete multipart uploads on the uploads bucket will not be auto-expired in this environment.',
        );
        return;
      }
      throw error;
    }
  }
}
