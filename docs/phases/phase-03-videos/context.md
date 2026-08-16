---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-13T22:55:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-16T16:27:42-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-08-13T22:55:02-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-13T22:55:02-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-13T22:55:02-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-13T22:55:02-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-13T22:55:02-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-13T22:55:02-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — file storage service, background processing queue, video upload/processing endpoints

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue Backend and Broker | decided | B | bullmq@^6, @nestjs/bullmq@^11 |
| phase-03-videos/TD-02 | phase | Backend | Bucket and Key Organization in Object Storage | decided | B | @aws-sdk/client-s3@^3 |
| phase-03-videos/TD-03 | phase | Repo-wide | MinIO Endpoint Topology — Signature Host vs. Docker Network | decided | A | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-04 | phase | Cross-layer | 10GB Upload Strategy | decided | B | @aws-sdk/s3-request-presigner@^3 |
|     └─ Last revision: 2026-08-15 — BFF half deferred: the three BFF Route Handlers under `app/api/videos/**` are owned by the future frontend slice | | | | | | |
| phase-03-videos/TD-05 | phase | Cross-layer | Video Status Model — Pipeline State vs. Publication State | decided | B | — |
| phase-03-videos/TD-06 | phase | Backend | Processing Failure, Retry, and Idempotency Policy | decided | A | — |
|     └─ Last revision: 2026-08-16 — Fixes the previously undetermined `processingError.code` for transient-failure retry exhaustion to `PROCESSING_FAILED` | | | | | | |
| phase-03-videos/TD-07 | phase | Repo-wide | Where and How the Video Worker Runs | decided | B | — |
| phase-03-videos/TD-08 | phase | Backend | FFmpeg Integration — Metadata Extraction and Thumbnail Generation | decided | B | — |
| phase-03-videos/TD-09 | phase | Backend | How the Worker Reads a 10GB Object | decided | B | @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-10 | phase | Cross-layer | Unique Video URL Identifier | decided | B | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Video Delivery — Streaming Playback and Download | decided | B | @aws-sdk/s3-request-presigner@^3 |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-07 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-04 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-07, phase-03-videos/TD-08 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it buys the BullMQ ergonomics that TD-06's retry/backoff policy depends on without adding a container to a Compose stack that is already split across two subprojects. The usual objection to a Postgres-backed queue (throughput) is irrelevant at one job per upload, and the usual objection to a young code path is neutralized by the fact that Option A is reachable by changing the backend factory and adding a `redis` service — no application code changes. Switch to Option A if the project later adds high-frequency job types (view counting, notification fan-out) or if the Postgres backend proves unstable in practice.
**Libraries:** bullmq@^6, @nestjs/bullmq@^11

### phase-03-videos/TD-02

**Recommendation:** the split exists to isolate the one bucket the browser is allowed to write to. That isolation is the whole point once TD-04 puts a presigned upload URL in the browser's hands, and it is the only layout where the CORS rule and the incomplete-multipart lifecycle rule can be scoped correctly. The copy step is one `CopyObject` call inside the worker, which is already handling the file. Keys stay `videoId`-addressed (Option C's channel prefix is rejected) so ownership changes never touch storage.
**Libraries:** @aws-sdk/client-s3@^3

### phase-03-videos/TD-03

**Recommendation:** it is the only option that keeps `CLAUDE.md`'s "service name, never localhost" rule intact for server-side I/O while producing browser-valid signatures, and it is the shape production actually has (internal VPC endpoint vs. public domain). MinIO belongs in `nestjs-project/compose.yaml` (the API owns it), with port `9000` published so the browser can reach it and `MINIO_SERVER_URL` set for the console. Note that `MINIO_SERVER_URL` alone does **not** fix SDK-generated presigned URLs — the endpoint used by the presigning client is what matters.
**Libraries:** @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3

### phase-03-videos/TD-04

**Recommendation:** it is the only option that satisfies both halves of the requirement simultaneously: the 10GB file never enters the API process (ruling out C and D), and the transfer is resumable at part granularity (ruling out A, which is additionally impossible above 5GB). `@uppy/aws-s3` removes essentially all of the client-side complexity that is Option B's main drawback. Reconsider Option C only if resume-across-browser-refresh becomes a hard requirement and the API is given dedicated upload capacity.
**Libraries:** @aws-sdk/s3-request-presigner@^3

**Revisions:**
- 2026-08-15 — The three control-plane calls (`CreateMultipartUpload`, presign `UploadPart`, `CompleteMultipartUpload`) are proxied by Next BFF Route Handlers under `app/api/videos/**`; only the browser→object-storage part transfer bypasses the BFF. Restates the Cross-layer note above so the constraint reaches `context.md` and is visible to `/plan-build`. Rationale: Constraint existed in TD prose but was invisible to downstream context.md.
- 2026-08-15 — Client half deferred: this slice implements only the NestJS control plane, storage and worker; "upload de até 10GB funcional" is verified by E2E against the API (CreateMultipartUpload → signed parts → Complete → job enqueued), with no browser client. `uppy` / `@uppy/aws-s3@^5` removed from **Libraries** and owned by the future frontend slice, which consumes this TD. Rationale: Client half deferred to the frontend slice that owns the UI.
- 2026-08-15 — BFF half deferred: the three BFF Route Handlers under `app/api/videos/**` are owned by the future frontend slice, together with the browser client. This slice delivers only the NestJS control plane, storage and worker — no `next-frontend/` artifact is implemented here, so `Affected subprojects` (consumer-only) and `## Testing Requirements → next-frontend` (no frontend artifact) in `context.md` stand as written. The BFF proxying recorded in the first 2026-08-15 revision describes the contract the frontend slice must honour when it lands, not work in scope here. Rationale: BFF half owned by the future frontend slice.

### phase-03-videos/TD-05

**Recommendation:** the plan already separates the pipeline (Fase 03) from publication (Fase 04), and the data model should mirror that rather than fight it. Concretely: `PENDING_UPLOAD` is written by the `CreateMultipartUpload` handshake of TD-04 (this is the "pré-cadastro automático"), `UPLOADING` on the first part, `PROCESSING` when the worker picks the job up, and `READY` or `FAILED` at the end, with a nullable `processingError` carrying a stable machine-readable reason code for the frontend and a human message for the owner. The video is only listable/playable at `READY` — and, from Fase 04 onward, only when also published.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** it is the only option that treats the two failure classes differently, which is the whole problem. Concretely: `attempts: 3`, exponential backoff, `UnrecoverableError` for "ffprobe reports no video stream" and similar deterministic outcomes, `jobId = videoId` for enqueue deduplication, deterministic output keys so a re-run is idempotent, and `removeOnComplete` with `removeOnFail: false` so failures remain inspectable. Do **not** delete the uploaded source object on terminal failure — it is needed both for diagnosis and for a reprocess attempt; the TD-02 lifecycle rule can expire orphans on a longer horizon.
**Libraries:** —

**Revisions:**
- **2026-08-16:** Fixes the previously undetermined `processingError.code` for transient-failure retry exhaustion to `PROCESSING_FAILED`. Rationale: implementing SI-03.9's `VideoProcessor` requires a concrete string for `Video.processingError.code` when the job exhausts its 3-attempt retry budget without a deterministic (`NO_VIDEO_STREAM`-style) cause; `PROCESSING_FAILED` is a generic catch-all distinct from `NO_VIDEO_STREAM`, consistent with the existing `SCREAMING_SNAKE_CASE` convention used by every other code in the Error Catalog.

### phase-03-videos/TD-07

**Recommendation:** it delivers the isolation the C4 diagram calls for and that FFmpeg's CPU profile demands, at the cost of one extra entrypoint file and one extra Dockerfile, while keeping a single dependency tree and a single source of truth for entities and config. Option C's isolation is not worth pulling monorepo-workspace tooling into this phase. Note for implementation: `nest-cli.json` will need a second build entry, and the existing `assets` config must keep working for both.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** with `fluent-ffmpeg` archived, the maintained path is the CLI itself, and the surface actually needed here (one probe, one frame extraction) is small enough that a wrapper is cheaper than any abstraction. Install FFmpeg via `apt` in `Dockerfile.worker.dev` (Option C's npm binaries add weight and postinstall fragility for no gain given a custom image already exists). Explicitly record Option D as out of scope so a later HLS phase is a deliberate decision rather than scope creep here.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** the job's actual read volume is a header plus one frame, so downloading 10GB to reach it is pure waste, and eliminating the temp-disk requirement removes the main scaling constraint on worker concurrency. Keep Option A available behind a small conditional: if the HTTP-input probe fails (a pathological container layout, a storage-side range limitation), retry the job once with a local download before declaring `FAILED`. This costs one code branch and turns the only real risk of Option B into a slow success rather than a failure.
**Libraries:** @aws-sdk/s3-request-presigner@^3

### phase-03-videos/TD-10

**Recommendation:** it is the only option that is simultaneously short, non-enumerable, stable across title edits, and dependency-free under the backend's CommonJS build. Establish the convention explicitly in the API contract: the public slug is what appears in URLs and OpenAPI responses; the UUID PK stays internal.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** it satisfies streaming and download with one mechanism, gets `Range`/`206` correctness from the storage layer for free instead of hand-rolling it, and keeps the API out of the data path, which is the phase's governing constraint. Set `Content-Type` when the worker promotes the object into the media bucket (TD-02), and expose playback via a dedicated endpoint returning a freshly-minted URL so TTL can be tuned without a client change. Option A remains the right answer only if per-range authorization ever becomes a hard requirement; Option C is ruled out by Fase 04's unlisted requirement.
**Libraries:** @aws-sdk/s3-request-presigner@^3

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** @nestjs/config@^4.x

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** joi@^17.x

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** dotenv (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** argon2@^0.41.x

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** @nestjs/jwt@^11.0.0

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** @nestjs-modules/mailer@^2.x, handlebars@^4.x

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** class-validator@^0.14.x, class-transformer@^0.5.x

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** @nestjs/throttler@^6.x

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** @nestjs/jwt@^11.0.0

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use. Option C is rejected as unsafe (`localStorage` for refresh tokens).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) Defense in depth on the cookie content — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) Single cookie to manage simplifies logout. (3) Room to carry minimal user metadata (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A. Option C's pre-emptive timer is rejected because the failure modes outweigh the latency saving.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) Decoupled from TD-05 — works with Route Handlers OR Server Actions. (2) Aligned with shadcn's canonical form primitive. (3) Zod-first developer ergonomics match the rest of the FE foundation.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) Strict-BFF alignment — every mutation stays visible under `app/api/**`. (2) Test scaffold already exists for Route-Handlers-as-functions. (3) Single mutation surface — Phase 02 sets the precedent for Phases 03–07.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) No first-render flicker, no round-trip — the session is delivered in the same response as the page HTML. (2) No new BFF endpoint — the cookie is the source of truth, RSC reads it, the Provider broadcasts it.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) First-paint-correct. (2) Single integration pattern across both flows (confirmation is RSC-only; reset is RSC + Client form). (3) Email-prefetch behavior solved at the backend's idempotent-confirmation level.
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** Option A (Zod 4). Type-inference matches the FE's strict-TS culture; Zod is the de-facto schema language for App Router; direct enablement of TD-02 Option A (`@t3-oss/env-nextjs`).
**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** Option A (`@t3-oss/env-nextjs`). The only option combining type-level `NEXT_PUBLIC_` prefix enforcement, runtime Proxy-based leak detection, and single-file consumer ergonomics.
**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** Option A (Strict BFF — single server-only `API_URL`). Aligned with the BFF testing strategy already documented in `next-frontend/CLAUDE.md`. Eliminates CORS, eliminates public exposure of the backend URL.
**Libraries:** —

### next-frontend-msw-foundation/TD-01

**Recommendation:** Option B (per-domain modules + barrel). MSW's own best-practice recommends it; domain ownership tracks the codebase; append-only growth with minimal merge conflicts.
**Libraries:** —

### next-frontend-msw-foundation/TD-02

**Recommendation:** Option A (test-only, `setupServer` only at the foundation). The browser worker is a future capability with no documented current consumer.
**Libraries:** —

### next-frontend-msw-foundation/TD-03

**Recommendation:** Option D (hand-written defaults as the default + opt-in seeded faker for bulk collections). Determinism + readability as baseline; faker available as a scoped tool for bulk-collection cases.
**Libraries:** —

### next-frontend-msw-foundation/TD-04

**Recommendation:** Option A (universal handler set + `server.use(...)` overrides + `onUnhandledRequest: "error"`). Loading all handlers is the canonical MSW v2 model and imposes no cost on tests that don't fetch the extra URLs.
**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** Option A (`openapi-typescript` + `openapi-fetch`). Strict BFF makes the SDK surface valueless on the client; types-first matches the rest of the FE foundation; MSW typing is solved by the same `paths` symbol.
**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-openapi-typing/TD-02

**Recommendation:** Option B (committed local copy + repo-root sync script). Preserves compose-stack independence; drift eliminated structurally when paired with TD-03's CI freshness check.
**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** Option C (committed + CI freshness check). The only option that makes contract drift both visible in PR diffs and impossible to merge accidentally.
**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** Option A (single `lib/api/contracts.ts` with explicit aliases). Handles pass-through and reshape with the same mechanism; single grep target for "what shape does the BFF expose".
**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** Option A (hand-written, typed via `paths`). Determinism over auto-generation; coherence with TD-01's `paths` as the single contract anchor.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
