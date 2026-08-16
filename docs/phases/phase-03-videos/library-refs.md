---
libs:
  bullmq:
    version: "^6.1.1"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-08-15T09:17:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-08-15T09:17:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1111.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-15T09:17:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1111.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-15T09:17:00-03:00"
  uppy:
    version: "^5.2.4"
    context7_id: "/websites/uppy_io"
    fetched_at: "2026-08-15T09:17:00-03:00"
  "@uppy/aws-s3":
    version: "^5.1.0"
    context7_id: "/websites/uppy_io"
    fetched_at: "2026-08-15T09:17:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-15T10:14:41-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice. Pulled via Context7. Re-fetch when the underlying TD changes (resolve refreshes this file when the lib set in `## Decisions Index` drifts from the cached set here).

## bullmq

**Source:** `/websites/bullmq_io` (Context7) — High reputation, 1510 snippets, benchmark 82.9. Maps to `phase-03-videos/TD-01` Decision B (PostgreSQL backend) and `TD-06` Decision A (retry/idempotency policy).

### Selecting the PostgreSQL backend

Two mechanisms exist. TD-01's note requires the **process-wide** one, because `@nestjs/bullmq@11` does not expose a `BackendFactory` pass-through.

```typescript
import { setDefaultBackendFactory, createPostgresBackend } from 'bullmq';

setDefaultBackendFactory(createPostgresBackend);
```

`setDefaultBackendFactory(factory?)` overrides the process-wide default `BackendFactory`, pointing every `Queue`, `Worker`, and `FlowProducer` at the alternate datastore without threading a factory through each constructor. Calling it with no argument resets to the Redis backend.

**Load-bearing ordering constraint:** it must run *before* any module instantiates a queue — i.e., at the top of both `main.ts` and the worker entrypoint (`main.worker.ts` per TD-07), above the `NestFactory` call.

The per-instance form (factory as the final constructor argument) is documented but unusable through `@nestjs/bullmq`:

```typescript
const queue = new Queue<any, any, string, PostgresQueueBackend>(
  'my-queue',
  { connection: 'postgres://user:password@localhost:5432/mydb' },
  createPostgresBackend,
);
```

### Connection and schema

`connection` accepts a connection string or an object. A dedicated schema keeps BullMQ's tables out of the application namespace:

```typescript
const opts = {
  connection: {
    connectionString: 'postgres://user:pass@db:5432/streamtube',
    schema: 'bullmq',
  },
};
```

Per `CLAUDE.md`, the host is the Compose service name (`db`), never `localhost`.

### Migrations

```
runMigrations(client, schema?, options?) -> Promise<number>
```

Brings the database schema up to `LATEST_SCHEMA_VERSION`, returning the resulting version. Handles upgrades atomically in a single transaction and uses **advisory locks** to prevent concurrent execution — safe when API and worker containers boot simultaneously.

- `client` — a *dedicated* session (`pg.PoolClient` or `pg.Client`), not the pool itself.
- `schema` — defaults to `DEFAULT_SCHEMA`; pass `'bullmq'` to match the connection config above.
- `options.skipVersionCheck` — optional.

Docs state it "should be called on the backend's first `waitUntilReady()`". Per TD-01's note this stays **separate from TypeORM's migration table** — do not fold it into `migration:run`.

### Retry, backoff, and terminal failure (TD-06)

```typescript
await queue.add('process-video', { videoId }, {
  jobId: videoId,          // enqueue deduplication
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: false,     // keep failures inspectable
});
```

`UnrecoverableError` short-circuits the retry budget — the job moves straight to `failed` even when `attemptsMade < attempts`. This is the primitive TD-06 uses for deterministic failures (e.g. "ffprobe reports no video stream"):

```typescript
import { Worker, UnrecoverableError } from 'bullmq';

const worker = new Worker('video', async job => {
  throw new UnrecoverableError('NO_VIDEO_STREAM');
}, { connection });
```

Constructor: `new UnrecoverableError(message?)`, defaulting to `"UNRECOVERABLE_ERROR"`.

**Note on deduplication.** BullMQ v6 has a `deduplication: { id, ttl }` option distinct from `jobId`. TD-06 chose `jobId = videoId`, which dedupes against jobs still present in the queue. Because TD-06 also sets `removeOnComplete: true`, a completed job's id is released — re-enqueueing the same `videoId` after success is possible by design (that is the reprocess path), so idempotency must additionally come from deterministic output keys, as TD-06 specifies.

## @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` (Context7) — High reputation, 3637 snippets, benchmark 83.3. The `/nestjs/bull` repo entry carries only 3 snippets; the framework docs' Queues chapter is the substantive source. Maps to `phase-03-videos/TD-01` and `TD-07`.

### Consumer shape

A consumer is a class decorated with `@Processor('<queue>')` extending `WorkerHost`, implementing `process`:

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video')
export class VideoConsumer extends WorkerHost {
  async process(job: Job<VideoJobData, void, string>): Promise<void> {
    await job.updateProgress(10);
    // ...
  }
}
```

### Registration

`BullModule.registerQueue({ name })` for the static case; `registerQueueAsync({ name, useFactory })` when options come from config. The queue **name must be declared outside the factory**:

```typescript
BullModule.registerQueueAsync({
  name: 'video',
  useFactory: () => ({ /* options */ }),
});
```

Per phase-01's inherited convention this factory injects `ConfigType<typeof queueConfig>` via `registerAs`.

### Standalone worker entrypoint (TD-07 Decision B)

`NestFactory.createApplicationContext(AppModule)` builds the Nest IoC container with **no network listeners** — the documented shape for workers and CLI scripts. Providers are resolved with `app.get()`, optionally module-scoped via `app.select()`:

```typescript
async function bootstrap() {
  setDefaultBackendFactory(createPostgresBackend);   // before the container boots
  const app = await NestFactory.createApplicationContext(AppModule);
}
bootstrap();
```

### Sandboxed processors — not used here

`registerQueue({ name, processors: [join(__dirname, 'processor.js')] })` forks job handlers into separate processes. This is TD-01/TD-07's rejected Option D: TD-07 chose container-level isolation instead, so the `processors` key stays absent.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation, 17935 snippets, benchmark 76.3. Maps to `phase-03-videos/TD-02`, `TD-03`, and the server half of `TD-04`.

### Client configuration for MinIO (TD-03 Decision A)

`ClientInputEndpointParameters` exposes the three knobs TD-03's two-client topology needs — `endpoint`, `forcePathStyle`, `region`:

```typescript
new S3Client({
  endpoint: 'http://minio:9000',   // internal: Compose service name
  forcePathStyle: true,            // MinIO does not do virtual-host addressing
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey },
});
```

The presign-only client is the same construction with `endpoint` set to the **public** value (`S3_PUBLIC_ENDPOINT`). It performs no I/O, so an endpoint unreachable from inside the container is harmless — which is precisely why TD-03's two-client split works.

`forcePathStyle` also changes the URL shape the SDK builds: `{protocol}//{host}:{port}/{bucket}/{key}` instead of `{bucket}.{host}`.

Related: `bucketEndpoint: true` treats `endpoint` as a bucket URL and makes the SDK ignore the `Bucket` parameter — **not** wanted here, since TD-02 uses two buckets from one client.

### Multipart upload (server-side control plane)

Canonical four-command flow:

```typescript
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));

const { ETag } = await s3.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body }));

await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ PartNumber, ETag }] },   // ETags collected in order
}));

await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));   // on failure
```

Under TD-04 the API only issues `CreateMultipartUpload`, `CompleteMultipartUpload`, and `AbortMultipartUpload`; `UploadPart` is executed by the browser against a presigned URL, so the part bytes never transit the API.

**Checksum caveat.** When `requestChecksumCalculation` is `WHEN_SUPPORTED` (the default in recent v3), the SDK injects `ChecksumAlgorithm: CRC32` into `CreateMultipartUpload` and expects matching per-part checksums at completion. Since the parts are uploaded by a browser that will not compute them, set `requestChecksumCalculation: 'WHEN_REQUIRED'` on the client, or the `CompleteMultipartUpload` will reject. This is the most likely first-run failure in the TD-04 handshake.

### Object promotion (TD-02)

The ingest → media copy is a single `CopyObjectCommand` (`CopySource: '{srcBucket}/{srcKey}'`), executed by the worker. Set `ContentType` here — TD-11 depends on it being correct on the media object.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7), package `packages/s3-request-presigner`. Maps to `phase-03-videos/TD-04`, `TD-09`, and `TD-11`.

### Basic presigning

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(client, new GetObjectCommand(params), { expiresIn: 3600 });
```

`expiresIn` is seconds and **defaults to 900** (15 min). TD-11's "short-lived" URLs should set it explicitly rather than rely on the default.

`getSignedUrl` works with any command — `GetObjectCommand` for playback/download (TD-11) and worker reads (TD-09), `UploadPartCommand` for the per-part URLs of TD-04.

### Response header override — the download path (TD-11)

S3 lets a `GetObject` request override a documented set of response headers (`Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Content-Type`, `Expires`) via query parameters:

```typescript
new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: `attachment; filename="${safeName}.mp4"`,
});
```

`getSignedUrl` resolves the command through the normal middleware pipeline including the serializer, so `ResponseContentDisposition` is serialized to the `response-content-disposition` query parameter and **is covered by the signature**. AWS docs are explicit that these parameters require a signed request or presigned URL — they cannot be used anonymously.

This is exactly TD-11's mechanism: the same object, presigned twice — once bare for streaming (browser sends `Range`, storage answers `206`), once with the disposition override for download.

### Signature host (TD-03)

`getSignedUrl` derives the signing region and host from the client's resolved endpoint. A URL presigned by a client pointing at `http://minio:9000` carries `minio:9000` in the signature and is unusable from the browser. This is the concrete reason TD-03 needs two clients rather than one — and, as TD-03's note says, MinIO's `MINIO_SERVER_URL` does not fix it, because the SDK signs against its own configured endpoint.

## uppy / @uppy/aws-s3

**Source:** `/websites/uppy_io` (Context7) — High reputation, 1211 snippets, benchmark 72.7. Maps to the client half of `phase-03-videos/TD-04`. Consumed by `next-frontend` in a future slice; decided here because the handshake shape is a cross-layer contract.

### Companion-less multipart

`@uppy/aws-s3` defaults to calling Companion's signing endpoints. TD-04 has no Companion — the four callbacks are overridden to call the API's control-plane endpoints instead:

```javascript
uppy.use(AwsS3, {
  shouldUseMultipart: true,

  async createMultipartUpload(file) {
    // POST /videos/uploads -> API calls CreateMultipartUpload
    return { uploadId, key };
  },

  async signPart(file, { uploadId, key, partNumber, signal }) {
    // GET /videos/uploads/:id/parts/:n -> API presigns UploadPartCommand
    return { url, headers };
  },

  async completeMultipartUpload(file, { uploadId, key, parts }) {
    // POST /videos/uploads/:id/complete  (parts = [{ ETag, PartNumber }])
    return { location };
  },

  async abortMultipartUpload(file, { uploadId, key }) { /* ... */ },
});
```

Contract details that pin the API's response shapes:

- `createMultipartUpload(file)` → `{ uploadId, key }`. `file` carries `file.name`, `file.type` — the API decides the key (TD-02: `videoId`-addressed), the client does not.
- `signPart(file, partData)` → `{ url, headers? }`. `partData` is `{ uploadId, key, partNumber, body, signal }`; `partNumber` is 1-based and never zero.
- `completeMultipartUpload(file, { uploadId, key, parts })` → `{ location? }`. `parts` is the S3-style array of `{ ETag, PartNumber }` — the browser collects the ETags from its own `PUT` responses, so **the ingest bucket's CORS rule must expose the `ETag` header**, or every part comes back with `ETag: null` and completion fails. This is the second likely first-run failure in TD-04.
- `getUploadParameters` is the *single-PUT* (non-multipart) callback — TD-04 rejected Option A, so it stays undefined.

`uppy` (core, `^5.2.4`) supplies the orchestration; `@uppy/aws-s3` (`^5.1.0`) supplies the plugin. Part-level retry and pause/resume within the page session come from the plugin. Resume *across a browser refresh* does not — that was TD-04's rejected Option C (tus).
