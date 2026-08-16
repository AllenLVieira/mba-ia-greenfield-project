import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';

export interface CompletedUploadPart {
  ETag: string;
  PartNumber: number;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly s3: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicS3: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  getIngestKey(videoId: string, extension: string): string {
    return `${videoId}/source${extension}`;
  }

  getMediaKey(videoId: string, extension: string): string {
    return `videos/${videoId}/video${extension}`;
  }

  getThumbnailKey(videoId: string): string {
    return `videos/${videoId}/thumbnail.jpg`;
  }

  async copyToMedia(
    sourceKey: string,
    destinationKey: string,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.config.mediaBucket,
        Key: destinationKey,
        CopySource: `${this.config.uploadsBucket}/${sourceKey}`,
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    );
  }

  async presignIngestGetObject(key: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.config.uploadsBucket, Key: key }),
      { expiresIn: this.config.presignTtlSeconds },
    );
  }

  async downloadIngestObjectToFile(
    key: string,
    destinationPath: string,
  ): Promise<void> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.uploadsBucket, Key: key }),
    );
    if (!Body) {
      throw new Error('GetObject did not return a Body');
    }
    await pipeline(Body as Readable, createWriteStream(destinationPath));
  }

  async putMediaObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.mediaBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async headObject(
    bucket: string,
    key: string,
  ): Promise<HeadObjectCommandOutput> {
    return this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.uploadsBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.uploadsBucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error('CreateMultipartUpload did not return an UploadId');
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicS3,
      new UploadPartCommand({
        Bucket: this.config.uploadsBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignTtlSeconds },
    );
  }

  async presignMediaGetObject(
    key: string,
    expiresInSeconds: number,
    responseContentDisposition?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.publicS3,
      new GetObjectCommand({
        Bucket: this.config.mediaBucket,
        Key: key,
        ResponseContentDisposition: responseContentDisposition,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[],
  ): Promise<string> {
    const { Location } = await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.uploadsBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    if (!Location) {
      throw new Error('CompleteMultipartUpload did not return a Location');
    }
    return Location;
  }
}
