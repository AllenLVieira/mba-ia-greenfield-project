# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (MinIO, S3-compatible) → video files and thumbnails
- **Message Queue** (BullMQ over PostgreSQL) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Video Module (Phase 03)

Upload and processing of videos. Videos belong to a channel; the pipeline keeps the API off the data path for large (up to 10GB) uploads.

**Module:** `nestjs-project/src/videos/` — `VideosModule` (entity `Video` linked to `Channel`, `VideosService`, `VideosUploadService`, controllers, `guards/video-owner.guard.ts`, `processing/` with `FfmpegService` + `VideoProcessor`).

**Endpoints** (all JWT-protected):

| Method & Route | Description |
|---|---|
| `POST /videos/uploads` | Pre-registers the video as a draft and opens the S3 multipart upload |
| `GET /videos/uploads/:uploadId/parts/:partNumber` | Presigns one `UploadPart` request (moves the video to `UPLOADING` on the first part) |
| `POST /videos/uploads/:uploadId/complete` | Finalizes the multipart upload and enqueues the processing job |
| `DELETE /videos/uploads/:uploadId` | Aborts the multipart upload |
| `GET /videos/:publicSlug` | Video pipeline status + extracted metadata |
| `GET /videos/:publicSlug/playback` | Mints a short-lived presigned `GetObject` URL for streaming (video must be `READY`) |
| `GET /videos/:publicSlug/download` | Mints a presigned URL with `Content-Disposition` so the browser saves the file |

**Status lifecycle:** `PENDING_UPLOAD → UPLOADING → PROCESSING → READY | FAILED`, persisted on the `videos` table.

**Upload strategy:** the client uploads parts **directly to MinIO** via presigned multipart URLs — the file never streams through the API. Each video has a unique `publicSlug` (unique constraint + index).

**Storage:** MinIO (S3-compatible, `minio` Compose service; swappable for S3 in prod). Object keys/buckets for the video file and the generated thumbnail.

**Queue:** BullMQ using the **PostgreSQL backend** (`createPostgresBackend`) — no Redis. The API publishes a `video` processing job on upload completion.

**Worker:** the `video-worker` Compose service runs `npm run start:dev:worker` (`src/main.worker.ts` → `WorkerModule`), a headless Nest context (no HTTP listener) that consumes the `video` queue and runs FFmpeg/ffprobe to extract duration/metadata and generate a thumbnail, then updates the DB and storage. It starts automatically with `docker compose up`.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.