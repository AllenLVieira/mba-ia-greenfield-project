import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import type { ProcessingError } from '../processing-error-code';

export enum VideoProcessingStatus {
  PENDING_UPLOAD = 'PENDING_UPLOAD',
  UPLOADING = 'UPLOADING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'public_slug', type: 'varchar', length: 11, unique: true })
  publicSlug: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ name: 'channel_id', type: 'uuid' })
  channelId: string;

  @Column({
    name: 'processing_status',
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.PENDING_UPLOAD,
  })
  processingStatus: VideoProcessingStatus =
    VideoProcessingStatus.PENDING_UPLOAD;

  @Column({ name: 'processing_error', type: 'jsonb', nullable: true })
  processingError: ProcessingError | null;

  @Column({ name: 'original_filename', type: 'varchar', length: 255 })
  originalFilename: string;

  @Column({ name: 'content_type', type: 'varchar', length: 255 })
  contentType: string;

  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes: string;

  @Column({ name: 'upload_id', type: 'varchar', length: 255, nullable: true })
  uploadId: string | null;

  @Column({ name: 'duration_seconds', type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  container: string | null;

  @Column({ name: 'video_codec', type: 'varchar', length: 50, nullable: true })
  videoCodec: string | null;

  @Column({ name: 'audio_codec', type: 'varchar', length: 50, nullable: true })
  audioCodec: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
