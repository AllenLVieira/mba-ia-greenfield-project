import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';

// Same requirement as `main.ts`: must run before any module instantiates a
// queue (per `phase-03-videos/TD-01`). Every e2e suite that bootstraps
// `AppModule` pulls in `QueueModule`, so this must run for all of them —
// not just the video-specific suites that already knew to do it inline.
setDefaultBackendFactory(createPostgresBackend);
