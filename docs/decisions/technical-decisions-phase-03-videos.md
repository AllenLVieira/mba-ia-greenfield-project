---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-13
scope_description: "Backend and infrastructure foundation for Phase 03 — background job queue, 10GB upload strategy that keeps the file out of the API process, the video worker runtime (FFmpeg metadata + thumbnail), object-storage bucket/key organization under MinIO, unique video URL generation, streaming/download delivery, and the video status lifecycle including processing-failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns the queue, the storage integration, the upload control-plane endpoints, the worker runtime, and the video status machine. Most TDs below are backend or repo-wide.
- `next-frontend/` — consumes the upload handshake (TD-04), the status contract (TD-05), the video URL shape (TD-10), and the playback/download URLs (TD-11). These are `Cross-layer` TDs and are decided once here, not split per side. Pure-UI decisions (player chrome, upload progress component, dropzone layout) belong to Fase 05 and to a future frontend slice — **no TD in this document covers them**.
- Repo-level (`compose.yaml` files, Dockerfiles, `.env` schema) — MinIO, the worker container, and the dual-endpoint env contract are `Repo-wide` (TD-03, TD-07).

**Documentation-lookup note:** `CLAUDE.md` mandates Context7 MCP for library API lookup. Context7 is **not** registered in this repository's `.mcp.json` (only `postgres` is). Research below was done against official documentation and the npm registry directly (`npm view` for installed/latest versions, peer deps, engines, and deprecation flags). Versions cited were verified on 2026-08-13.

---

## TD-01: Queue Backend and Broker

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The plan marks the Message Queue as TBD in the C4 diagram. This is the load-bearing stack decision of the phase: it determines whether a new infrastructure container (Redis, RabbitMQ) enters `compose.yaml`, which NestJS integration package is used, and what the retry/DLQ primitives look like for TD-06. The workload is small in volume (one job per uploaded video — tens per day at most) but each job is long-running and CPU-heavy. Throughput is a non-issue; operational surface and retry ergonomics are the real criteria.

**Options:**

### Option A: BullMQ v6 with the Redis backend
- `bullmq@6` + `@nestjs/bullmq@11` + an explicit `ioredis@6` install (v6 demoted ioredis to an *optional peer* dependency), plus a `redis` service in `nestjs-project/compose.yaml`. Redis 6.2+ required.
- **Pros:** The most battle-tested Node queue; official NestJS package (`@Processor` + `WorkerHost`); rich primitives out of the box (exponential backoff, `UnrecoverableError`, job schedulers, rate limiting, flows, Bull Board UI); the reference answer a reviewer expects.
- **Cons:** Adds a third infrastructure container and a second datastore to operate, back up, and reason about. Redis is not durable by default — job state can be lost on an unclean restart unless AOF is configured. New env keys, new healthcheck, new failure mode.

### Option B: BullMQ v6 with the PostgreSQL backend
- BullMQ 6.0.0 (released 2026-07-30) introduced pluggable backends: the same `Queue`/`Worker`/`QueueEvents`/`FlowProducer` API runs on PostgreSQL via `createPostgresBackend`, in a dedicated `bullmq` schema initialized by `runMigrations()`. Requires PostgreSQL 13+ (the project runs 17) and the `pg` package (already installed).
- **Pros:** Zero new containers — reuses the existing `db` service. Full feature parity with the Redis backend (backoff, priorities, delayed jobs, deduplication, schedulers, events). Jobs are durable and transactional alongside relational data. **Switching to Redis later is a one-line change** to the backend factory, because the application-facing API is identical — the decision is genuinely reversible.
- **Cons:** The newest and least battle-tested code path in BullMQ (the docs themselves state Redis "remains the default and the most battle-tested option"). Throughput is 1.5–2× lower than Redis (irrelevant here: ~11k jobs/s worker processing vs ~18k). **`@nestjs/bullmq@11.0.5` does not expose a `BackendFactory` pass-through** — verified by inspecting the published `dist/`; the backend must be selected process-wide via `setDefaultBackendFactory()` during bootstrap, before any module instantiates a queue. That is a small, documented bootstrap ordering constraint, not a blocker.

### Option C: pg-boss v12
- A PostgreSQL-native job queue using `SELECT … FOR UPDATE SKIP LOCKED`. Requires Node ≥22.12 (container runs 25) and `pg@^8.22` (project has `^8.20` — a minor bump).
- **Pros:** Purpose-built for Postgres, mature, simple mental model, no new infra, good scheduling/archival support.
- **Cons:** No official NestJS integration — the module wiring, DI, and graceful shutdown are hand-rolled. Migrating to Redis later means rewriting every producer and consumer, not swapping a factory. Smaller ecosystem and no equivalent of Bull Board.

### Option D: RabbitMQ via `@nestjs/microservices`
- A real broker with a NestJS transport adapter.
- **Pros:** Proper AMQP semantics, DLQ as a first-class concept, language-agnostic if the worker were ever rewritten outside Node.
- **Cons:** Heaviest operational surface by far (broker container, vhosts, exchanges, bindings). No built-in job-state model — retries, backoff, and progress tracking must be built on top. Massively over-scaled for one job type at this volume.

**Recommendation:** **Option B (BullMQ v6 + PostgreSQL backend)** — it buys the BullMQ ergonomics that TD-06's retry/backoff policy depends on without adding a container to a Compose stack that is already split across two subprojects. The usual objection to a Postgres-backed queue (throughput) is irrelevant at one job per upload, and the usual objection to a young code path is neutralized by the fact that Option A is reachable by changing the backend factory and adding a `redis` service — no application code changes. Switch to Option A if the project later adds high-frequency job types (view counting, notification fan-out) or if the Postgres backend proves unstable in practice.

**Decision:** B (BullMQ v6 with the PostgreSQL backend)
**Libraries:** bullmq@^6, @nestjs/bullmq@^11

---

## TD-02: Bucket and Key Organization in Object Storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Object storage itself is settled (S3-compatible → MinIO in Docker locally, S3 in production). What is open is how objects are laid out: bucket count and key naming. This is a cross-component contract — the bucket names appear in the Joi env schema, `.env.example`, the MinIO bootstrap in `compose.yaml`, the API's storage service, and the worker — and the layout determines which lifecycle, CORS, and access policies can be expressed at all, since those are configured **per bucket** in S3/MinIO.

**Options:**

### Option A: Single bucket with type prefixes
- One bucket (`streamtube`) with `videos/{videoId}/original.mp4`, `videos/{videoId}/thumbnail.jpg`.
- **Pros:** Simplest possible setup — one bucket to create, one policy to manage. Everything about a video is under one prefix, so deletion is a single prefix sweep.
- **Cons:** CORS must be opened on the bucket that also holds derived artifacts, because browser-direct upload (TD-04) requires it. A lifecycle rule to abort incomplete multipart uploads cannot be scoped to raw uploads only. Public-read policies, if ever needed for thumbnails, would apply to originals too.

### Option B: Two buckets split by role — `streamtube-uploads` and `streamtube-media`
- `streamtube-uploads` receives the raw file the browser PUTs (`{videoId}/source{ext}`); the worker reads from it and writes derived artifacts to `streamtube-media` (`videos/{videoId}/video{ext}`, `videos/{videoId}/thumbnail.jpg`).
- **Pros:** CORS and the "abort incomplete multipart uploads after N days" lifecycle rule apply only to the ingest bucket — the bucket the browser can write to is the *only* one with a permissive policy. Derived artifacts live in a bucket the browser never writes to. Clean blast radius: a bug in presigning cannot overwrite a served asset. Maps directly onto how S3 pipelines are normally built.
- **Cons:** A copy step (server-side `CopyObject`, or a re-upload from the worker) is needed to promote the original into the media bucket, and two bucket names become two env keys and two bootstrap steps.

### Option C: Single bucket, prefix per channel
- `{channelId}/{videoId}/…` in one bucket.
- **Pros:** Natural per-channel accounting and per-channel prefix policies later.
- **Cons:** Inherits every Option A drawback, and additionally couples the storage key to channel ownership — a video moving channels (or a channel rename) would orphan or require rewriting keys. The `videoId` is already globally unique, so the channel segment carries no addressing value.

**Recommendation:** **Option B (two buckets)** — the split exists to isolate the one bucket the browser is allowed to write to. That isolation is the whole point once TD-04 puts a presigned upload URL in the browser's hands, and it is the only layout where the CORS rule and the incomplete-multipart lifecycle rule can be scoped correctly. The copy step is one `CopyObject` call inside the worker, which is already handling the file. Keys stay `videoId`-addressed (Option C's channel prefix is rejected) so ownership changes never touch storage.

**Decision:** B (Two buckets - streamtube-uploads ingest / streamtube-media derived, videoId-addressed keys)
**Libraries:** @aws-sdk/client-s3@^3

---

## TD-03: MinIO Endpoint Topology — Signature Host vs. Docker Network

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** SigV4 signs the `Host` header, so a presigned URL is only valid against the exact host it was generated for. In this repo the API container reaches MinIO by its Compose service name (`http://minio:9000`) while the browser can only reach it through a published port (`http://localhost:9000`) — and a browser cannot resolve a Compose service name at all. Rewriting the host in the URL string yields `SignatureDoesNotMatch`. This bites both TD-04 (presigned upload) and TD-11 (presigned playback), so it must be settled before either. It is compounded by the fact that `nestjs-project/` and `next-frontend/` currently run as **two separate Compose stacks with no shared network** (`next-frontend` reaches the API via `host.docker.internal`).

**Options:**

### Option A: Two endpoint values, two S3 clients
- `S3_ENDPOINT=http://minio:9000` (internal, used for all server-side I/O) and `S3_PUBLIC_ENDPOINT=http://localhost:9000` (browser-facing, used only to generate presigned URLs). Two `S3Client` instances; the presigning client performs no network I/O, so its endpoint never has to be reachable from the API container.
- **Pros:** Correct by construction — each URL is signed for the host that will actually receive the request. Costs one extra env key and a few lines in the storage module. In production both values collapse to the same public S3/CDN domain, so the shape is production-accurate rather than a dev-only hack. No Compose networking changes and no proxy to operate.
- **Cons:** Two clients to keep configured consistently; a developer who presigns with the wrong client gets a confusing runtime failure (mitigated by exposing only `presignPut`/`presignGet` from the storage service, never the raw clients).

### Option B: One endpoint for everything, made resolvable from both sides
- Use `http://localhost:9000` everywhere and give the API container a route to it (`network_mode: host`, or a `minio` alias plus a host-file entry, or `extra_hosts`).
- **Pros:** A single env key; only one client; presigned URLs are trivially correct.
- **Cons:** Requires host-networking tricks that behave differently on Linux, macOS, and Windows/WSL2 — the project runs on Windows 11. Makes the API's storage access depend on the host's published-port mapping instead of the Docker network, which is the exact pattern `CLAUDE.md` forbids ("always use the Docker Compose service name as the host — never `localhost`").

### Option C: Reverse proxy in front of MinIO
- An nginx/Caddy container on the Compose network, with one hostname resolvable identically from container and host.
- **Pros:** A single endpoint value with no host-networking tricks; also a place to terminate TLS later.
- **Cons:** A fourth container and a proxy config to maintain, purely to work around a dev-only addressing quirk. It also has to be tuned for 10GB request bodies (`client_max_body_size`, buffering off) or it silently becomes the bottleneck the presigned upload was meant to avoid.

**Recommendation:** **Option A (two endpoints, two clients)** — it is the only option that keeps `CLAUDE.md`'s "service name, never localhost" rule intact for server-side I/O while producing browser-valid signatures, and it is the shape production actually has (internal VPC endpoint vs. public domain). MinIO belongs in `nestjs-project/compose.yaml` (the API owns it), with port `9000` published so the browser can reach it and `MINIO_SERVER_URL` set for the console. Note that `MINIO_SERVER_URL` alone does **not** fix SDK-generated presigned URLs — the endpoint used by the presigning client is what matters.

**Decision:** A (Internal + public endpoints, two S3 clients)
**Libraries:** @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3

---

## TD-04: 10GB Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The plan's headline non-functional requirement, and the phase's hardest constraint: a 10GB file must reach storage without occupying the API's event loop, without buffering to the API container's disk, and — per `docs/project-plan.md` § Pontos de Atenção — with the ability to resume after a connection failure. This is inherently cross-layer: the handshake sequence is split between browser and API, and the choice determines both the endpoint set on the backend and the uploader used on the frontend. It also interacts with `next-frontend/CLAUDE.md`'s strict-BFF rule (see the note below the recommendation).

**Options:**

### Option A: Single presigned PUT
- The API returns one presigned `PutObject` URL; the browser PUTs the whole file to MinIO/S3.
- **Pros:** The simplest possible handshake — one endpoint, one URL, no completion step. The file never touches the API.
- **Cons:** **Hard-fails the requirement:** S3's single `PutObject` is capped at 5GB, so a 10GB file cannot be uploaded this way at all. No resume — a drop at 9GB restarts from zero. No progress granularity beyond the browser's own upload events.

### Option B: Presigned S3 multipart upload
- Three control-plane calls through the API — `CreateMultipartUpload`, presign N `UploadPart` URLs, `CompleteMultipartUpload` — with the browser PUTting each part directly to storage. `@uppy/aws-s3@5` implements the client half of exactly this handshake; the AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) implements the server half.
- **Pros:** Supports up to 5TB (10K parts × ≤5GiB). Resumable at part granularity — after a failure the client asks which parts landed (`ListParts`) and re-uploads only the missing ones. Parallel part uploads make a 10GB transfer materially faster. Accurate progress for free. The API handles three small JSON requests regardless of file size, so the event loop is never in the data path. Storage-agnostic: identical against MinIO and S3.
- **Cons:** The most moving parts of any option — the browser must be given a *set* of URLs and must report ETags back on completion. Requires CORS on the ingest bucket and the public endpoint from TD-03. Abandoned multipart uploads leak storage until a lifecycle rule aborts them (TD-02 Option B scopes that rule correctly).

### Option C: tus protocol via `@tus/server` + `@tus/s3-store`
- The Nest app speaks the tus resumable protocol (`POST` to create, `PATCH` chunks with `Upload-Offset`, `HEAD` to resume); `@tus/s3-store` translates chunks into S3 multipart parts behind the scenes. Requires Node ≥20.19 (container runs 25).
- **Pros:** The cleanest resumability semantics of any option — resume across a browser refresh, not just a network blip, is native to the protocol. One well-specified protocol instead of a hand-rolled three-call handshake. Excellent client (`tus-js-client`, also an Uppy plugin).
- **Cons:** **Every byte flows through the Node process**, which is precisely the property the capability says to avoid — the API becomes the bandwidth bottleneck and cannot be scaled independently of upload traffic. Adds two dependencies plus a raw-body route that must be excluded from global pipes/guards. Chunk buffering consumes API container disk/memory.

### Option D: Proxy streaming through the API
- `multer`/`busboy` streams the request into `@aws-sdk/lib-storage`'s `Upload` (which does multipart internally).
- **Pros:** Fewest endpoints; storage credentials never leave the server; no CORS work; the API can validate content as it streams.
- **Cons:** Same fatal property as Option C — the file transits the API — with none of tus's resumability upside. A dropped connection at 9GB restarts from zero. Directly contradicts "sem impacto na performance".

**Recommendation:** **Option B (presigned S3 multipart)** — it is the only option that satisfies both halves of the requirement simultaneously: the 10GB file never enters the API process (ruling out C and D), and the transfer is resumable at part granularity (ruling out A, which is additionally impossible above 5GB). `@uppy/aws-s3` removes essentially all of the client-side complexity that is Option B's main drawback. Reconsider Option C only if resume-across-browser-refresh becomes a hard requirement and the API is given dedicated upload capacity.

**Cross-layer note on the BFF rule:** `next-frontend/CLAUDE.md` forbids the browser from calling the NestJS API directly. Option B does not violate it — the three control-plane calls go through BFF Route Handlers under `app/api/videos/**` as usual. What is new is that the browser talks directly to **object storage**, which is not the API and was never covered by that rule (`next-frontend/CLAUDE.md` already anticipates this: "Media streaming will eventually come from Object Storage (S3/MinIO) — TBD"). The presigned URLs are short-lived, scoped to a single key, and reach the browser only through the BFF. This exception should be written into `next-frontend/CLAUDE.md` when the phase is implemented, so the rule stays unambiguous.

**Decision:** B (Presigned S3 multipart via API control plane + @uppy/aws-s3 client)
**Libraries:** @aws-sdk/s3-request-presigner@^3

**Revisions:**

- 2026-08-15 — The three control-plane calls (`CreateMultipartUpload`, presign `UploadPart`, `CompleteMultipartUpload`) are proxied by Next BFF Route Handlers under `app/api/videos/**`; only the browser→object-storage part transfer bypasses the BFF. Restates the Cross-layer note above so the constraint reaches `context.md` and is visible to `/plan-build`. Rationale: Constraint existed in TD prose but was invisible to downstream context.md.
- 2026-08-15 — Client half deferred: this slice implements only the NestJS control plane, storage and worker; "upload de até 10GB funcional" is verified by E2E against the API (CreateMultipartUpload → signed parts → Complete → job enqueued), with no browser client. `uppy` / `@uppy/aws-s3@^5` removed from **Libraries** and owned by the future frontend slice, which consumes this TD. Rationale: Client half deferred to the frontend slice that owns the UI.
- 2026-08-15 — BFF half deferred: the three BFF Route Handlers under `app/api/videos/**` are owned by the future frontend slice, together with the browser client. This slice delivers only the NestJS control plane, storage and worker — no `next-frontend/` artifact is implemented here, so `Affected subprojects` (consumer-only) and `## Testing Requirements → next-frontend` (no frontend artifact) in `context.md` stand as written. The BFF proxying recorded in the first 2026-08-15 revision describes the contract the frontend slice must honour when it lands, not work in scope here. Rationale: BFF half owned by the future frontend slice.

---

## TD-05: Video Status Model — Pipeline State vs. Publication State

**Scope:** Cross-layer

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)`

**Context:** The plan says the video is pre-registered "como rascunho" when the upload starts, and Fase 04 then introduces an explicit rascunho → publicação flow plus público/unlisted visibility. Those are two different axes — a video can be fully processed and still unpublished, or published and still processing if the model allows it — and conflating them produces states that cannot be expressed. The status is also a wire contract: the frontend polls it to decide whether to show a spinner, a player, or an error, so it must be decided once for both sides. Whatever shape is chosen here is what Fase 04 and Fase 05 build on.

**Options:**

### Option A: One enum covering everything
- `videos.status` ∈ `DRAFT | UPLOADING | PROCESSING | READY | PUBLISHED | FAILED`.
- **Pros:** One column, one field on the wire, trivially readable. A single switch on the frontend renders the whole lifecycle.
- **Cons:** The two axes collide immediately: what is the status of a video that finished processing but has not been published? `READY` and `PUBLISHED` are not sequential states of the same machine — publishing an unprocessed video and processing a published video are both legitimate. Fase 04's unlisted visibility is a third axis that does not fit at all. Every future combination forces a new enum member, and the set grows combinatorially.

### Option B: Two orthogonal axes — `processingStatus` + publication fields
- `videos.processingStatus` ∈ `PENDING_UPLOAD | UPLOADING | PROCESSING | READY | FAILED` owns the Phase 03 pipeline exclusively. Publication (`visibility`, `publishedAt`) is introduced by Fase 04 as separate columns and is **not** decided here.
- **Pros:** Each axis has one owner and one lifecycle; no invalid or ambiguous combinations. Phase 03 ships without pre-empting Fase 04's design. "Rascunho" is expressed exactly as the plan means it — a video that exists but is not published — independently of how far the pipeline has advanced. The frontend's polling logic keys off one small, closed enum. Adding `TRANSCODING` later (if HLS is ever introduced) touches one axis.
- **Cons:** Two things to read instead of one; the UI must combine them for the management panel in Fase 04 (e.g. "Rascunho · Processando"). Marginally more columns.

### Option C: Event-sourced status
- An append-only `video_events` table; current status is derived by projection.
- **Pros:** Full audit trail of every transition — genuinely useful for debugging a distributed pipeline. No lost history on retries.
- **Cons:** Every read needs a projection or a maintained materialized column, which reintroduces the same modeling question one layer down. Substantial complexity for a five-state machine with one writer. Not justified at this scale.

**Recommendation:** **Option B (two orthogonal axes)** — the plan already separates the pipeline (Fase 03) from publication (Fase 04), and the data model should mirror that rather than fight it. Concretely: `PENDING_UPLOAD` is written by the `CreateMultipartUpload` handshake of TD-04 (this is the "pré-cadastro automático"), `UPLOADING` on the first part, `PROCESSING` when the worker picks the job up, and `READY` or `FAILED` at the end, with a nullable `processingError` carrying a stable machine-readable reason code for the frontend and a human message for the owner. The video is only listable/playable at `READY` — and, from Fase 04 onward, only when also published.

**Decision:** B (processingStatus pipeline axis orthogonal to Fase 04 publication fields)

---

## TD-06: Processing Failure, Retry, and Idempotency Policy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** FFmpeg jobs fail for two very different reasons: transient causes (storage hiccup, worker restart mid-job, OOM under concurrency) and deterministic ones (the uploaded file is not a video, or is corrupt). Retrying the first class is correct; retrying the second burns CPU to reach the same failure. The policy also has to be idempotent, because at-least-once delivery means a job can legitimately run twice — and "run twice" must not mean "two thumbnails and a double-counted duration". The resulting terminal state is what TD-05's `FAILED` and `processingError` expose to the user, so this is a contract decision, not just a worker detail.

**Options:**

### Option A: Bounded retries with backoff, error classification, and manual re-trigger
- `attempts: 3` with exponential backoff (~30s base); deterministic failures throw BullMQ's `UnrecoverableError` to skip remaining attempts; `jobId = videoId` makes enqueueing naturally deduplicated; the worker is written to be re-runnable (it overwrites derived objects at deterministic keys rather than appending). Terminal failure sets `processingStatus = FAILED` + `processingError`, and the owner can re-trigger via `POST /videos/:id/reprocess`.
- **Pros:** Covers both failure classes correctly with primitives BullMQ already provides in either backend from TD-01 — almost no custom code. The user is never permanently stuck on a transient fault. Failed jobs stay in the queue's `failed` set, which is a de facto DLQ for inspection. Fixed, predictable upper bound on wasted CPU.
- **Cons:** Requires deliberately classifying errors at each FFmpeg call site instead of letting everything bubble. The reprocess endpoint is extra API surface (small, and needed for support anyway).

### Option B: No automatic retry — fail fast, user retries
- First failure is terminal; the UI offers "try again".
- **Pros:** Trivial to implement and to reason about. Zero risk of retry storms.
- **Cons:** A one-second storage blip forces a user who just waited out a 10GB upload to start over. Poor experience for the exact failure mode that is most common and most recoverable.

### Option C: Unbounded retries with backoff
- Retry until it succeeds.
- **Pros:** Nothing transient is ever lost.
- **Cons:** A permanently invalid file retries forever, holding a worker slot and generating unbounded log noise. The video never reaches a terminal state, so the UI can never tell the user anything actionable.

**Recommendation:** **Option A** — it is the only option that treats the two failure classes differently, which is the whole problem. Concretely: `attempts: 3`, exponential backoff, `UnrecoverableError` for "ffprobe reports no video stream" and similar deterministic outcomes, `jobId = videoId` for enqueue deduplication, deterministic output keys so a re-run is idempotent, and `removeOnComplete` with `removeOnFail: false` so failures remain inspectable. Do **not** delete the uploaded source object on terminal failure — it is needed both for diagnosis and for a reprocess attempt; the TD-02 lifecycle rule can expire orphans on a longer horizon.

**Decision:** A (3 attempts + backoff, UnrecoverableError for deterministic failures, jobId = videoId)

**Revisions:**

- **2026-08-16:** Fixes the previously undetermined `processingError.code` for transient-failure retry exhaustion to `PROCESSING_FAILED`. Rationale: implementing SI-03.9's `VideoProcessor` requires a concrete string for `Video.processingError.code` when the job exhausts its 3-attempt retry budget without a deterministic (`NO_VIDEO_STREAM`-style) cause; `PROCESSING_FAILED` is a generic catch-all distinct from `NO_VIDEO_STREAM`, consistent with the existing `SCREAMING_SNAKE_CASE` convention used by every other code in the Error Catalog.

---

## TD-07: Where and How the Video Worker Runs

**Scope:** Repo-wide

**Capability:** Transversal — covers: `Serviço de processamento em segundo plano (filas)`, `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** `docs/diagrams/software-arch.mermaid` already models a **Video Worker (FFmpeg)** as its own container. What is open is how that is realized in a monorepo that currently has exactly two subprojects and two independent Compose stacks: does the worker share the API's codebase and image, get its own subproject, or not exist as a separate process at all? This determines the Dockerfile layout, where the FFmpeg binary is installed, and whether TypeORM entities and config are shared or duplicated.

**Options:**

### Option A: In-process — processor registered in the API
- `@Processor('video-processing')` lives in `AppModule`; the API process is also the worker.
- **Pros:** Nothing new to build — no second image, no second service, no second entrypoint. Entities, config, and DI are shared by definition. Simplest local development.
- **Cons:** FFmpeg is CPU-saturating; running it in the API process starves HTTP request handling for the duration of every job. FFmpeg must be installed in the API image, inflating it for a binary the API never calls. Worker and API cannot be scaled or restarted independently. Directly contradicts the C4 diagram.

### Option B: Separate container, same codebase and image, different entrypoint
- A `src/main.worker.ts` bootstrapped with `NestFactory.createApplicationContext(WorkerModule)` (no HTTP listener), a `Dockerfile.worker.dev` that adds `ffmpeg` on top of the same base, and a `video-worker` service in `nestjs-project/compose.yaml`.
- **Pros:** Matches the C4 diagram exactly. Full reuse of entities, `registerAs` config, TypeORM data source, and the domain exception model — no duplication and no drift. FFmpeg is installed only in the worker image. Independent scaling and restart; a crashing worker never takes the API down. One `npm install`, one lint config, one test suite.
- **Cons:** A second Nest entrypoint and a second Dockerfile to maintain; `WorkerModule` must be curated so the worker does not accidentally pull in HTTP-only providers. Two containers to start in local development.

### Option C: A separate `video-worker/` subproject
- Its own `package.json`, `tsconfig`, Dockerfile, and Compose stack.
- **Pros:** Hard isolation; could be rewritten in another language later without touching the API.
- **Cons:** Entities, migrations, config, and storage-client code must be duplicated or extracted into a shared package — the monorepo has no `packages/*` tooling today, so this pulls a workspace-manager decision into Phase 03 that nothing else needs. Two dependency trees to keep in sync. Highest cost, no benefit the project can currently use.

### Option D: BullMQ sandboxed processor
- The processor is a separate file that BullMQ forks as a child process.
- **Pros:** Isolates a crashing or blocking job from the main event loop without a second container.
- **Cons:** The child still lives inside the API container, so FFmpeg must ship in the API image and CPU is still contended on the same host. Sandboxed processors have their own constraints (no DI container by default, serialized job data only), which fights NestJS conventions.

**Recommendation:** **Option B (second container, shared codebase)** — it delivers the isolation the C4 diagram calls for and that FFmpeg's CPU profile demands, at the cost of one extra entrypoint file and one extra Dockerfile, while keeping a single dependency tree and a single source of truth for entities and config. Option C's isolation is not worth pulling monorepo-workspace tooling into this phase. Note for implementation: `nest-cli.json` will need a second build entry, and the existing `assets` config must keep working for both.

**Decision:** B (Separate container, same codebase and image, createApplicationContext entrypoint)

---

## TD-08: FFmpeg Integration — Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The worker must read duration, resolution, codec, and container from the uploaded file, and cut one frame into a JPEG thumbnail. The obvious library choice is a trap: **`fluent-ffmpeg` was archived in May 2025 and is flagged deprecated on npm** ("Package no longer supported"), with its maintainers noting it no longer works correctly with recent FFmpeg versions. Choosing it would be adopting abandonware on day one. How the binary is obtained (system package vs. npm-bundled) is also a cross-component question, since it determines what `Dockerfile.worker.dev` installs.

**Options:**

### Option A: `fluent-ffmpeg`
- The historical fluent wrapper API.
- **Pros:** Enormous amount of tutorial material; expressive chained API; bundled `ffprobe` JSON parsing.
- **Cons:** Archived and deprecated; incompatible with recent FFmpeg builds; no security or bug fixes. Disqualifying for a greenfield project in 2026.

### Option B: Direct `child_process.spawn` of `ffmpeg` / `ffprobe`, with a thin typed wrapper
- The worker image installs FFmpeg via `apt`; a small internal module (~60 LOC) exposes `probe(input): VideoMetadata` and `extractThumbnail(input, at): Buffer`, invoking `ffprobe -v quiet -print_format json -show_format -show_streams` and `ffmpeg -ss … -i … -frames:v 1 -f image2 -`.
- **Pros:** Zero dependencies and zero abandonment risk — FFmpeg's CLI is the most stable interface in the ecosystem. Full control over arguments (which matters for TD-09's HTTP-input seeking). `ffprobe`'s JSON output maps directly onto a typed interface. Easy to unit-test by stubbing the spawn boundary and to integration-test against a small fixture. Version pinned and auditable at the image level.
- **Cons:** Argument strings are hand-written and must be correct; stderr parsing for progress (if ever needed) is manual. Requires FFmpeg present in the image (already implied by TD-07 Option B).

### Option C: `ffmpeg-static` + `ffprobe-static` npm binaries
- Binaries downloaded as npm packages instead of installed via `apt`.
- **Pros:** No Dockerfile change; version pinned in `package.json`; identical binary across environments.
- **Cons:** Adds ~80MB to `node_modules` on a bind-mounted volume; postinstall downloads make the image build network-dependent and slower; platform-specific binaries interact badly with mounting host `node_modules` into a Linux container. Solves a problem the project does not have — the worker image is already custom.

### Option D: Full transcoding to HLS/ABR
- Segment into multiple renditions and serve an HLS manifest.
- **Pros:** True adaptive bitrate streaming; the production-grade answer for a real video platform.
- **Cons:** Far outside the phase — the plan asks only for duration/metadata extraction and one thumbnail, and Fase 05's player requirement is progressive playback. Multiplies processing time and storage. Should be a future phase, not smuggled into this one.

**Recommendation:** **Option B (direct `spawn` + thin typed wrapper)** — with `fluent-ffmpeg` archived, the maintained path is the CLI itself, and the surface actually needed here (one probe, one frame extraction) is small enough that a wrapper is cheaper than any abstraction. Install FFmpeg via `apt` in `Dockerfile.worker.dev` (Option C's npm binaries add weight and postinstall fragility for no gain given a custom image already exists). Explicitly record Option D as out of scope so a later HLS phase is a deliberate decision rather than scope creep here.

**Decision:** B (Direct spawn of ffmpeg/ffprobe + thin typed wrapper)

---

## TD-09: How the Worker Reads a 10GB Object

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** TD-08 settles which tool runs; this settles what it is pointed at. With 10GB inputs the access strategy is an infrastructure decision, not a detail: downloading each job's source to local disk means the worker container needs 10GB × concurrency of ephemeral storage plus the full transfer time before any work starts. Since the job only needs a header read and a single frame, that may be almost entirely wasted I/O.

**Options:**

### Option A: Download the object to a temp file, then run FFmpeg on it
- `GetObject` streamed to `/tmp/{videoId}`, processed, then deleted in a `finally`.
- **Pros:** The most predictable path — FFmpeg gets a real seekable local file, so every container format and every flag combination behaves normally. Failure modes are simple and local. No storage-endpoint coupling inside the worker.
- **Cons:** Requires provisioning 10GB × worker concurrency of ephemeral disk and enforcing it as a hard operational constraint. Full transfer latency (potentially minutes) before processing begins, for a job that reads a few megabytes. Leaked temp files after an unclean crash need their own cleanup.

### Option B: Point FFmpeg at a presigned GET URL and let it seek over HTTP range
- The worker generates a short-lived presigned GET (internal endpoint, per TD-03) and passes it as FFmpeg's input; FFmpeg's HTTP protocol issues Range requests, so `ffprobe` reads only the header and `ffmpeg -ss <t> -i <url>` seeks to the frame instead of streaming the whole file.
- **Pros:** No local disk requirement at all — worker concurrency stops being bounded by ephemeral storage. Typically seconds instead of minutes, since only the bytes actually needed are transferred. No temp-file lifecycle and no crash-leak cleanup. Scales to larger files without re-provisioning.
- **Cons:** For MP4s written without `faststart` the `moov` atom sits at the end of the file, so FFmpeg must range-read the tail before it can seek — still far cheaper than a full download, but it means the strategy's cost is format-dependent rather than constant. Any storage misconfiguration surfaces as an opaque FFmpeg I/O error. Requires FFmpeg to be built with network protocol support (standard in Debian's package).

### Option C: Mount the bucket as a filesystem (s3fs/goofys)
- The worker treats storage as a local path.
- **Pros:** Application code is oblivious to object storage.
- **Cons:** Requires privileged/FUSE containers, has well-known consistency and performance pitfalls, and adds an operational component with no upside over Option B, which already gets range-based access through a supported protocol.

**Recommendation:** **Option B (presigned GET + HTTP range), with Option A as a per-job fallback** — the job's actual read volume is a header plus one frame, so downloading 10GB to reach it is pure waste, and eliminating the temp-disk requirement removes the main scaling constraint on worker concurrency. Keep Option A available behind a small conditional: if the HTTP-input probe fails (a pathological container layout, a storage-side range limitation), retry the job once with a local download before declaring `FAILED`. This costs one code branch and turns the only real risk of Option B into a slow success rather than a failure.

**Decision:** B (Presigned GET + HTTP range seeking, local-download fallback on probe failure)
**Libraries:** @aws-sdk/s3-request-presigner@^3

---

## TD-10: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The plan flags this in § Pontos de Atenção: each video needs a short, unique URL that never collides. The identifier is a cross-layer contract — it appears in the Next.js route segment, in the API path, in the OpenAPI schema, and in every share link — and it is effectively permanent once links exist in the wild. It is also worth separating from the primary key: exposing a sequential database ID leaks total video count and enables trivial enumeration.

**Options:**

### Option A: Expose the UUID primary key
- `/watch/9f8c3b12-4d5e-4a7b-9c1d-2e3f4a5b6c7d`.
- **Pros:** Zero extra columns, zero extra code, no collision handling — the PK is already unique. Consistent with the existing entities.
- **Cons:** 36 characters is hostile in a share link and unusable in a QR code or a spoken URL. The plan explicitly asks for a *short* URL. Reads as an internal identifier leaking into the product surface.

### Option B: Short random public slug alongside the UUID PK
- An 11-character `base64url` slug (~66 bits of entropy) in a `UNIQUE`, indexed column, generated with `crypto.randomBytes(8).toString('base64url')`; retry on the (astronomically unlikely) unique-violation.
- **Pros:** The YouTube shape, and short enough to share. Entropy makes enumeration and count-leaking infeasible. Decoupled from the PK, so the internal key can change without breaking links. **Zero new dependencies** — and that matters concretely here: `nanoid@6` is ESM-only (`"type": "module"`) while the backend compiles to CommonJS (`typeorm-ts-node-commonjs`, `ts-jest`), and `@paralleldrive/cuid2` is ESM-only too; `crypto.randomBytes` sidesteps that interop question entirely. Collision handling is a `UNIQUE` constraint plus a retry, which the database enforces regardless of application bugs.
- **Cons:** One extra column, one extra index, and a few lines of generation/retry logic. Two identifiers for the same entity, so the codebase must be disciplined about which one crosses the API boundary.

### Option C: Encoded sequential ID (Sqids/Hashids)
- Encode an auto-increment integer into a short string.
- **Pros:** Short, guaranteed collision-free by construction, reversible to the numeric ID.
- **Cons:** Reversible is the problem — the encoding is obfuscation, not entropy, so total video count and creation order remain inferable and IDs remain enumerable. Requires an auto-increment column the schema does not have (entities use UUID PKs). Adds a dependency to achieve less than Option B.

### Option D: Title slug + random suffix
- `/watch/meu-video-de-ferias-a1b2c3`.
- **Pros:** Human-readable and marginally better for SEO.
- **Cons:** The title is editable in Fase 04, which forces a choice between breaking existing links and letting the slug drift from the title. Needs Unicode normalization, profanity/length handling, and per-title collision logic. Considerably more complexity than the capability asks for.

**Recommendation:** **Option B (11-char random slug in a `UNIQUE` column)** — it is the only option that is simultaneously short, non-enumerable, stable across title edits, and dependency-free under the backend's CommonJS build. Establish the convention explicitly in the API contract: the public slug is what appears in URLs and OpenAPI responses; the UUID PK stays internal.

**Decision:** B (11-char crypto.randomBytes base64url slug in a UNIQUE column)

---

## TD-11: Video Delivery — Streaming Playback and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** Two capabilities, one mechanism. Progressive playback requires the origin to honor `Range` and answer `206 Partial Content` — without it, HTML5 `<video>` cannot seek and must buffer from the start. Download requires the same bytes delivered with `Content-Disposition: attachment`. The decision is where those bytes come from, and it is cross-layer because it determines both the API's response shape and what the frontend puts in `<video src>`. As with TD-04, the strict-BFF rule constrains calls to the *API*, not to object storage.

**Options:**

### Option A: Proxy the stream through the API (or the BFF)
- The API receives the player's `Range` header, issues a corresponding ranged `GetObject`, and pipes back a `206` with `Content-Range`.
- **Pros:** Storage stays entirely private; per-request authorization is possible on every byte range, which matters for unlisted videos in Fase 05; a single origin means no CORS work.
- **Cons:** Puts the API in the data path for every second of every playback — precisely the bottleneck the phase exists to avoid, and worse than the upload case because playback traffic is continuous. `206`/`Content-Range` semantics are hand-implemented and easy to get subtly wrong. Node event-loop pressure scales with concurrent viewers.

### Option B: Short-lived presigned GET URLs issued by the API
- The API authorizes the request and returns a presigned `GetObject` URL (public endpoint, per TD-03); the browser points `<video src>` at storage. **MinIO and S3 already implement `Range`/`206` natively**, so seeking works with no streaming code at all. Download reuses the same object with `ResponseContentDisposition=attachment; filename="…"` on the presigned URL.
- **Pros:** The API never touches video bytes; playback scales with storage, not with the Node process. Range/seek support is free and correct. One mechanism serves both capabilities — the *only* difference between the play URL and the download URL is a response-header override parameter. Production-ready: swapping MinIO for S3+CloudFront changes only how the URL is minted.
- **Cons:** The storage host is visible to the browser (mitigated: URLs are short-lived and key-scoped). URL expiry must exceed the viewing session or the player breaks mid-video on a long title — so either a generous TTL (e.g. 6h) or a `GET /videos/:slug/playback-url` endpoint the player can re-call. Requires the correct `Content-Type` (`video/mp4`) to be set at upload/copy time, or some browsers refuse inline playback.

### Option C: Public bucket (+ CDN later)
- Objects are world-readable at a stable URL.
- **Pros:** Simplest possible delivery; trivially cacheable; CDN-ready.
- **Cons:** Incompatible with Fase 04's unlisted visibility and with any future private/draft video — a leaked or guessed key is permanently public with no revocation. Making the bucket public also undermines TD-02's isolation rationale.

**Recommendation:** **Option B (short-lived presigned GET)** — it satisfies streaming and download with one mechanism, gets `Range`/`206` correctness from the storage layer for free instead of hand-rolling it, and keeps the API out of the data path, which is the phase's governing constraint. Set `Content-Type` when the worker promotes the object into the media bucket (TD-02), and expose playback via a dedicated endpoint returning a freshly-minted URL so TTL can be tuned without a client change. Option A remains the right answer only if per-range authorization ever becomes a hard requirement; Option C is ruled out by Fase 04's unlisted requirement.

**Decision:** B (Short-lived presigned GET with native Range/206, Content-Disposition override for download)
**Libraries:** @aws-sdk/s3-request-presigner@^3

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Queue backend and broker | **B** — BullMQ v6 with the PostgreSQL backend (no new container; Redis reachable by swapping the factory) | **B** |
| TD-02 | Backend | Bucket and key organization | **B** — two buckets (`streamtube-uploads` ingest / `streamtube-media` derived), `videoId`-addressed keys | **B** |
| TD-03 | Repo-wide | MinIO endpoint topology (signature host) | **A** — internal + public endpoints, two S3 clients (presign-only client does no I/O) | **A** |
| TD-04 | Cross-layer | 10GB upload strategy | **B** — presigned S3 multipart via API control plane + `@uppy/aws-s3` client | **B** |
| TD-05 | Cross-layer | Video status model | **B** — `processingStatus` pipeline axis orthogonal to Fase 04 publication fields | **B** |
| TD-06 | Backend | Failure, retry, and idempotency policy | **A** — 3 attempts + backoff, `UnrecoverableError` for deterministic failures, `jobId = videoId` | **A** |
| TD-07 | Repo-wide | Video worker runtime | **B** — separate container, same codebase/image, `createApplicationContext` entrypoint | **B** |
| TD-08 | Backend | FFmpeg integration | **B** — direct `spawn` of `ffmpeg`/`ffprobe` + thin typed wrapper (`fluent-ffmpeg` is archived) | **B** |
| TD-09 | Backend | How the worker reads a 10GB object | **B** — presigned GET + HTTP range seeking, local-download fallback on probe failure | **B** |
| TD-10 | Cross-layer | Unique video URL identifier | **B** — 11-char `crypto.randomBytes` base64url slug in a `UNIQUE` column | **B** |
| TD-11 | Cross-layer | Streaming playback and download | **B** — short-lived presigned GET (`Range`/`206` native), `Content-Disposition` override for download | **B** |

---

## Notes for downstream pipeline

- **Capability coverage.** All nine Phase 03 capability bullets are cited by at least one TD above: storage service (TD-02, TD-03), queue service (TD-01, TD-07), 10GB upload (TD-04), draft pre-registration (TD-05), metadata extraction (TD-06, TD-08, TD-09), thumbnail generation (TD-07, TD-08), unique URL (TD-10), streaming playback (TD-11), user download (TD-11). The authoritative aggregate table is built by `/plan-context`.
- **Dependency chain.** TD-03 gates TD-04 and TD-11 — presigned URLs are unusable until the endpoint topology is settled. TD-01 gates TD-06 (the retry primitives named in TD-06 are BullMQ's and exist in both of TD-01's backends, so the coupling survives an A/B swing). TD-07 gates TD-08 and TD-09 (both assume the worker is the container that has FFmpeg). TD-02 gates TD-09 and TD-11 (which bucket is read from and served). TD-05 is consumed by Fase 04's publication flow and Fase 05's player states.
- **TD-01 Option B implementation constraints, verified in the published package:** `@nestjs/bullmq@11.0.5` does not expose a `BackendFactory` pass-through, so the Postgres backend must be selected with `setDefaultBackendFactory(createPostgresBackend)` in `main.ts` and `main.worker.ts` **before** any module instantiates a queue, and `runMigrations()` must run against the `bullmq` schema (kept separate from TypeORM's migration table — do not fold it into `migration:run`). BullMQ v6 also demoted `ioredis` to an optional peer, so Option A requires installing it explicitly.
- **New dependencies under the recommended set:** `bullmq@^6` (TD-01 B — `pg` is already installed), `@nestjs/bullmq@^11` (TD-01 B), `@aws-sdk/client-s3@^3` + `@aws-sdk/s3-request-presigner@^3` (TD-02/03/04/09/11), and on the frontend `uppy` + `@uppy/aws-s3@^5` (TD-04 B). No dependency is needed for TD-08 (system FFmpeg via `apt`) or TD-10 (`node:crypto`). `fluent-ffmpeg`, `nanoid`, and `@paralleldrive/cuid2` are explicitly **not** adopted, for the reasons recorded in TD-08 and TD-10.
- **Infra surface for `/plan-build`:** a `minio` service + a `createbuckets` init step in `nestjs-project/compose.yaml` (with CORS on the ingest bucket and an abort-incomplete-multipart lifecycle rule per TD-02); a `video-worker` service + `Dockerfile.worker.dev` installing `ffmpeg` (TD-07); new Joi-validated env keys (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_BUCKET_UPLOADS`, `S3_BUCKET_MEDIA`, plus `QUEUE_*`) mirrored into `.env.example` and `src/config/*.config.ts` per `phase-01/TD-03`'s `registerAs` convention.
- **Cross-subproject contract.** The upload handshake, status polling, playback-URL, and download endpoints all flow through the existing OpenAPI chain (`openapi-docs-nestjs/TD-02` → `next-frontend-openapi-typing/TD-01..TD-05`), so no new shared-types decision is needed — `next-frontend` consumes them as generated `paths` types and mocks them in `mocks/handlers/videos.ts` per `next-frontend-msw-foundation/TD-01`.
- **CLAUDE.md updates implied by the recommendations:** `next-frontend/CLAUDE.md` should record the object-storage exception to the strict-BFF rule (TD-04 note) and replace its "Media streaming will eventually come from Object Storage (S3/MinIO) — TBD" line with the TD-11 outcome; `nestjs-project/CLAUDE.md` should document the `video-worker` service and its container-only commands alongside the existing `nestjs-api`/`db`/`mailpit` list.
- **Out of scope, recorded deliberately:** HLS/ABR transcoding (TD-08 Option D), CDN fronting (TD-11 Option C), and resume-across-browser-refresh via tus (TD-04 Option C). Each is a defensible future phase; none is required by a Phase 03 capability.

Sources consulted during research:

- [BullMQ changelog — 6.0.0 (2026-07-30)](https://docs.bullmq.io/changelog) — pluggable backends, `BackendFactory` replacing the `Connection` parameter, `ioredis` demoted to optional peer, legacy repeatable jobs removed.
- [BullMQ — PostgreSQL backend](https://docs.bullmq.io/guide/postgresql) — `createPostgresBackend`, `runMigrations()`, PostgreSQL 13+ requirement, feature parity, and the documented 1.5–2× throughput gap vs. Redis.
- [BullMQ — NestJS guide](https://docs.bullmq.io/guide/nestjs) and [NestJS — Queues](https://docs.nestjs.com/techniques/queues) — `@Processor` + `WorkerHost`, `BullModule.forRoot`/`registerQueue`, sandboxed processors.
- [pg-boss](https://www.npmjs.com/package/pg-boss) (v12.27.0, Node ≥22.12, `pg@^8.22`) — `SKIP LOCKED` dequeue model evaluated as TD-01 Option C.
- [`@tus/s3-store`](https://www.npmjs.com/package/@tus/s3-store) and [tus-node-server v1 announcement](https://tus.io/blog/2023/09/04/tus-node-server-v100) — S3 multipart translation, ≥5MiB/≤5GiB part sizing, 10K-part ceiling, `Tus-Completed` lifecycle tagging.
- [Uppy — choosing an uploader](https://uppy.io/docs/guides/choosing-uploader/) and `@uppy/aws-s3@5.1.0` — client-side implementation of the presigned-multipart handshake adopted in TD-04.
- [minio/minio#14241](https://github.com/minio/minio/issues/14241), [minio/minio#10222](https://github.com/minio/minio/issues/10222), [minio-py#1427](https://github.com/minio/minio-py/issues/1427) — SigV4 host binding, `SignatureDoesNotMatch` on host rewrite, and confirmation that `MINIO_SERVER_URL` does not affect SDK-generated presigned URLs. Basis for TD-03.
- [fluent-ffmpeg#1324 — "Phasing out fluent-ffmpeg"](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324) and the [npm deprecation notice](https://www.npmjs.com/package/fluent-ffmpeg) — repository archived May 2025; basis for rejecting TD-08 Option A.
- [Serving private S3 objects: proxy vs. gateway auth vs. presigned URLs](https://georg-schwarz.com/blog/serving-private-s3-objects-backend-proxy-gateway-auth-presigned-urls/) and [Node.js S3 streaming with 206 support](https://dev.to/edumqs/nodejs-stream-from-s3-with-partial-content-support-324i) — delivery-pattern trade-offs behind TD-11.
- npm registry (`npm view`, 2026-08-13) — version, `engines`, `peerDependencies`, and deprecation checks for every package named above; `nanoid@6` and `@paralleldrive/cuid2` confirmed `"type": "module"` (ESM-only), which drives TD-10's dependency-free recommendation.
- In-repo constraints consumed as hard inputs: `docs/decisions/technical-decisions-phase-01-configuracao-base.md` (Joi + `registerAs` config), `…phase-02-auth.md` (domain exception filter, error envelope), `…openapi-docs-nestjs.md` + `…next-frontend-openapi-typing.md` + `…next-frontend-msw-foundation.md` (contract chain), `nestjs-project/CLAUDE.md`, `next-frontend/CLAUDE.md` (strict BFF), `docs/diagrams/software-arch.mermaid` (Video Worker as its own container).
