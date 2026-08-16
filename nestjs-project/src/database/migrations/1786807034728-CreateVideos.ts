import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1786807034728 implements MigrationInterface {
  name = 'CreateVideos1786807034728';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('PENDING_UPLOAD', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_slug" character varying(11) NOT NULL, "title" character varying(255) NOT NULL, "channel_id" uuid NOT NULL, "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'PENDING_UPLOAD', "processing_error" jsonb, "original_filename" character varying(255) NOT NULL, "content_type" character varying(255) NOT NULL, "size_bytes" bigint NOT NULL, "upload_id" character varying(255), "duration_seconds" integer, "width" integer, "height" integer, "container" character varying(50), "video_codec" character varying(50), "audio_codec" character varying(50), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_29611dc31b2c902c8f489fc065c" UNIQUE ("public_slug"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_29611dc31b2c902c8f489fc065" ON "videos" ("public_slug") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_29611dc31b2c902c8f489fc065"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
  }
}
