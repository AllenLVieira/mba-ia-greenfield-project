---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-15T10:18:41-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-15T10:18:42-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-15T10:14:41-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-13T22:55:02-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend and infrastructure foundation for video ingestion: a BullMQ processing queue, a presigned-multipart upload control plane that keeps 10GB files out of the API process, MinIO bucket/key organization, a separate FFmpeg worker container that extracts metadata and generates thumbnails, unique per-video URL slugs, and streaming/download delivery via short-lived presigned URLs — so that upload de até 10GB, processamento automático, streaming and URLs únicas are all functional end-to-end against the API.

---

## Step Implementations

### SI-03.1 — Provisionar MinIO no Compose e a configuração de storage

**Description:** Coloca o object storage de pé e materializa o contrato de dois endpoints (interno para I/O server-side, público para assinaturas válidas no browser) como configuração tipada e validada — pré-requisito de todo o resto da fase.

**Technical actions:**

1. Adicionar o serviço `minio` em `nestjs-project/compose.yaml` — imagem `minio/minio`, portas `9000` (API) e `9001` (console) publicadas, `MINIO_SERVER_URL` apontando para o host público, healthcheck e volume nomeado; `nestjs-api` ganha `depends_on` do MinIO (per `phase-03-videos/TD-03`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` expondo `internalEndpoint`, `publicEndpoint`, `region`, `accessKeyId`, `secretAccessKey`, `uploadsBucket`, `mediaBucket` e `presignTtlSeconds` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-02`)
3. Estender o schema Joi em `src/config/env.validation.ts` com as chaves de storage como obrigatórias — o endpoint interno usa o nome do serviço Compose, nunca `localhost` (per `CLAUDE.md` § Docker Networking)
4. Atualizar `.env.example` com o par de endpoints e os dois nomes de bucket

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage.config.ts` | Unit: factory mapeia env → objeto tipado, TTL default | `src/config/storage.config.spec.ts` |
| `env.validation.ts` | Integration: schema rejeita env sem as chaves de storage | `src/config/env.validation.integration-spec.ts` _(extend)_ |

**Dependencies:** none

**Acceptance criteria:**

- Subir o stack expõe a API do MinIO em `9000` e o console em `9001`, com o bucket console acessível pelas credenciais do `.env`
- O boot da API com qualquer chave de storage ausente falha na validação de env nomeando a chave faltante
- A configuração resolvida entrega endpoints interno e público distintos, com o interno igual ao nome do serviço Compose

---

### SI-03.2 — Implementar o módulo de storage com clientes S3 interno e público

**Description:** Entrega o serviço de armazenamento de arquivos: dois clientes S3 (um para I/O dentro da rede Docker, um só para assinar URLs válidas no browser), a derivação determinística de chaves endereçadas por `videoId` e o provisionamento dos dois buckets.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3` e `@aws-sdk/s3-request-presigner@^3`
2. Criar `src/storage/storage.module.ts` — provê dois `S3Client` sob tokens distintos (interno e público) via factory injetando `ConfigType<typeof storageConfig>`, ambos com `forcePathStyle: true` (MinIO não faz virtual-host addressing) e `requestChecksumCalculation: 'WHEN_REQUIRED'`, sem o qual o `CompleteMultipartUpload` de `phase-03-videos/TD-04` rejeita partes enviadas pelo browser (per `phase-03-videos/TD-03`)
3. Criar `src/storage/storage.service.ts` — derivação determinística das chaves de ingest, mídia e thumbnail a partir do `videoId`, mais `copyObject` (ingest → mídia com `ContentType` no destino), `headObject` e `abortMultipartUpload` (per `phase-03-videos/TD-02`)
4. Criar `src/storage/bucket-provisioner.ts` — garante os dois buckets no boot, aplica no bucket de uploads a regra CORS que **expõe o header `ETag`** (sem ela o cliente não consegue coletar os ETags das partes) e a regra de lifecycle que expira multipart incompleto (per `phase-03-videos/TD-02`)
5. Registrar `StorageModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: contrato real contra MinIO — copy com `ContentType`, head, abort, chaves determinísticas | `src/storage/storage.service.integration-spec.ts` |
| `BucketProvisioner` | Integration: buckets criados, CORS expondo `ETag`, lifecycle de multipart incompleto aplicado | `src/storage/bucket-provisioner.integration-spec.ts` |
| `StorageModule` | Unit: compilação e DI dos dois clientes | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — os endpoints e nomes de bucket vêm da configuração criada lá

**Acceptance criteria:**

- Após o boot, os buckets de uploads e de mídia existem no MinIO e a regra CORS do bucket de uploads lista `ETag` entre os headers expostos
- Uma cópia de ingest para mídia preserva o `ContentType` informado no objeto de destino
- Uma URL assinada pelo cliente público carrega o host público na assinatura; a mesma operação assinada pelo cliente interno carrega o nome do serviço Compose
- Duas chamadas de derivação de chave para o mesmo `videoId` produzem exatamente a mesma chave

---

### SI-03.3 — Provisionar a fila `video` com BullMQ v6 sobre PostgreSQL

**Description:** Entrega o serviço de processamento em segundo plano sem adicionar Redis ao stack: BullMQ v6 apontado para o PostgreSQL já existente, com a política de retry e deduplicação da fase embutida nas opções default do job.

**Technical actions:**

1. Instalar `bullmq@^6` e `@nestjs/bullmq@^11`
2. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` retornando `connectionString` (host = nome do serviço Compose) e `schema: 'bullmq'`, mantendo as tabelas da fila fora do namespace da aplicação; adicionar as chaves ao schema Joi (per `phase-03-videos/TD-01`)
3. Chamar `setDefaultBackendFactory(createPostgresBackend)` no topo de `src/main.ts`, **acima** da chamada `NestFactory` — `@nestjs/bullmq@11` não expõe pass-through de `BackendFactory`, então a seleção do backend é process-wide e precisa correr antes de qualquer fila ser instanciada (per `phase-03-videos/TD-01`)
4. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` + `registerQueueAsync({ name: 'video' })` e as opções default de job de `### Events/Messages → Job options`: `attempts: 3`, backoff exponencial, `removeOnComplete: true`, `removeOnFail: false` (per `phase-03-videos/TD-06`)
5. Criar o bootstrap de `runMigrations(client, 'bullmq')` em sessão dedicada, separado do `migration:run` do TypeORM — os advisory locks tornam seguro o boot simultâneo de API e worker (per `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilação e DI de `registerQueueAsync` com opções vindas do config | `src/queue/queue.module.spec.ts` |
| `queue.config.ts` | Unit: factory mapeia env → connection string + schema | `src/config/queue.config.spec.ts` |
| bullmq migrations | Integration: schema `bullmq` criado; execução concorrente converge para a mesma versão | `src/queue/queue-migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Após o boot, o schema `bullmq` existe no PostgreSQL e nenhum serviço Redis foi adicionado ao stack
- Enfileirar duas vezes o mesmo `jobId` enquanto o primeiro job ainda está na fila resulta em um único job
- Um job que falha em todas as tentativas permanece consultável na fila; um job concluído com sucesso é removido
- Um job que falha de forma transitória é reexecutado até 3 vezes com intervalos crescentes

---

### SI-03.4 — Modelar o domínio de vídeo: entidade, migration, `publicSlug` e exceções

**Description:** Materializa o modelo de dados da fase — a entidade `Video` com o eixo `processingStatus`, o identificador público de 11 caracteres e as exceções de domínio que todo o resto da fase lança.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video`, com `@Column({ name: '...' })` explícito mapeando as propriedades camelCase dos TDs para colunas snake_case do schema, e a relação `ManyToOne` com `Channel` (mais a inversa `OneToMany` no lado do canal) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)
2. Criar `src/videos/public-slug.util.ts` — 11 caracteres base64url via `randomBytes` do `node:crypto`, sem dependência externa e estável a edições de título (per `phase-03-videos/TD-10`)
3. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções de `### Error Catalog` estendendo o `DomainException` existente: `VideoNotFoundException` (404), `UploadNotFoundException` (404), `VideoAccessDeniedException` (403), `InvalidUploadStateException` (409) e `VideoNotReadyException` (409) (per `phase-02-auth/TD-07`)
4. Criar `src/videos/processing-error-code.ts` com o código `NO_VIDEO_STREAM` e o formato `{ code, message }` persistido em `processingError` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
5. Gerar a migration da tabela `videos` e criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, default de `processingStatus`, unicidade de `publicSlug`, FK de canal, nulabilidade dos metadados | `src/videos/entities/video.entity.integration-spec.ts` |
| `public-slug.util.ts` | Unit: comprimento 11, alfabeto base64url, ausência de colisão em amostra grande | `src/videos/public-slug.util.spec.ts` |
| migration `videos` | Integration: aplica e reverte sobre o schema das fases anteriores | `src/database/migrations.integration-spec.ts` _(extend)_ |

**Dependencies:** none

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `publicSlug` viola a constraint UNIQUE
- Um vídeo criado sem `processingStatus` explícito nasce em `PENDING_UPLOAD`
- `durationSeconds`, `width`, `height`, `container`, `videoCodec` e `audioCodec` aceitam `null` enquanto o processamento não concluiu
- Um vídeo não pode ser gravado sem `channelId`, `title`, `originalFilename`, `contentType` e `sizeBytes`
- A migration aplica e reverte sem afetar as tabelas criadas nas Fases 01 e 02

---

### SI-03.5 — Implementar o serviço do control plane de upload multipart

**Description:** Concentra a regra de negócio das quatro chamadas de controle do upload de 10GB — pré-cadastro do rascunho, assinatura de partes, finalização com enfileiramento e cancelamento — mantendo os bytes do arquivo fora do processo da API.

**Technical actions:**

1. Criar `src/videos/videos-upload.service.ts` com `initiate()` — gera o `publicSlug`, pré-cadastra o `Video` em `PENDING_UPLOAD` com `title` derivado do `filename` sem extensão e `channelId` resolvido do canal da sessão, emite `CreateMultipartUploadCommand` no bucket de uploads e persiste o `uploadId` retornado (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)
2. Implementar `signPart()` — presigna `UploadPartCommand` com o cliente **público** e TTL explícito, e transiciona `PENDING_UPLOAD → UPLOADING` na primeira parte assinada (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`)
3. Implementar `complete()` — envia `CompleteMultipartUploadCommand` com `MultipartUpload.Parts` ordenado por `PartNumber`, limpa o `uploadId` e enfileira o job `process-video` com `jobId` igual ao id do vídeo (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`)
4. Implementar `abort()` — `AbortMultipartUploadCommand` liberando as partes incompletas e limpando o `uploadId` (per `phase-03-videos/TD-04`)
5. Implementar `assertOwnership()` — resolve o canal da sessão e compara com `Video.channelId`, lançando `VideoAccessDeniedException`; estados fora de `PENDING_UPLOAD`/`UPLOADING` lançam `InvalidUploadStateException` (per `### Authorization Matrix` § Delegation)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosUploadService` | Unit: transições de status, ordenação de parts, dedupe de enqueue, branches de ownership e de estado inválido (repo/storage/fila mockados) | `src/videos/videos-upload.service.spec.ts` |
| `VideosUploadService` | Integration: contrato real contra MinIO e DB — `initiate` → `signPart` → `complete` com job enfileirado | `src/videos/videos-upload.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (clientes S3 e chaves), SI-03.3 (fila `video`), SI-03.4 (entidade e exceções)

**Acceptance criteria:**

- `initiate` grava um vídeo em `PENDING_UPLOAD` com `title` derivado do `filename` sem extensão e vinculado ao canal do autor da chamada
- Assinar a primeira parte move o vídeo para `UPLOADING`; assinar partes seguintes não altera o status
- `complete` deixa exatamente um job `process-video` na fila, identificado pelo id do vídeo, e zera o `uploadId`
- `signPart` ou `complete` sobre um vídeo fora de `PENDING_UPLOAD`/`UPLOADING` falha com `INVALID_UPLOAD_STATE`
- Qualquer operação disparada por quem não é dono do vídeo falha com `VIDEO_ACCESS_DENIED`
- `abort` torna o `uploadId` inexistente para chamadas subsequentes

---

### SI-03.6 — Expor os endpoints do control plane de upload

**Route:** POST /videos/uploads, GET /videos/uploads/{uploadId}/parts/{partNumber}, POST /videos/uploads/{uploadId}/complete, DELETE /videos/uploads/{uploadId}
**Test Specs:** see `nestjs-project/specs/videos-uploads.plan.md`
**Authorization:** Autenticado e dono do vídeo (per `### Authorization Matrix`); `POST /videos/uploads` é a única rota sem vídeo pré-existente e vincula o vídeo criado ao canal do chamador

**Description:** Publica as quatro chamadas de controle do handshake de upload no formato que o cliente `@uppy/aws-s3` da futura fatia de frontend consome sem adaptador, com validação, guard de propriedade e documentação OpenAPI.

**Technical actions:**

1. Criar os DTOs em `src/videos/dto/` (`initiate-upload.dto.ts`, `complete-upload.dto.ts` e os DTOs de resposta) com `class-validator` seguindo `### Validation Rules — upload control plane`, incluindo `partNumber` inteiro ≥ 1 e `parts` não vazio com `ETag` e `PartNumber` por entrada (per `phase-02-auth/TD-06`)
2. Criar `src/videos/videos-upload.controller.ts` com as quatro rotas de `### API Contracts`, retornando exatamente `{ uploadId, key }`, `{ url, headers }`, `{ location }` e `204`, sob `JwtAuthGuard` e decoradas com `@nestjs/swagger` (per `phase-03-videos/TD-04`, `openapi-docs-nestjs/TD-01`)
3. Criar `src/videos/guards/video-owner.guard.ts` delegando a checagem a `VideosUploadService.assertOwnership()` em vez de ler `channelId` da request (per `### Authorization Matrix` § Delegation)
4. Registrar controller e guard em `VideosModule`, e `VideosModule` em `AppModule`

**Tests:** _(empty — E2E only per testing-guide-nestjs-project § Controller/DTO/Guard; scenarios authored via **Test Specs**)_

**Dependencies:** SI-03.5 — o controller apenas expõe a regra já implementada no serviço

**Acceptance criteria:**

- `POST /videos/uploads` com corpo válido e token de um usuário com canal retorna `201` com `uploadId`, `key` e `publicSlug`
- `GET /videos/uploads/{uploadId}/parts/{partNumber}` com `partNumber` menor que 1 retorna `400` de validação
- Qualquer rota do control plane sem `Authorization` retorna `401` com `errorCode: "INVALID_TOKEN"`
- Um usuário autenticado que não é dono do upload recebe `403` com `errorCode: "VIDEO_ACCESS_DENIED"`
- `POST /videos/uploads/{uploadId}/complete` com `parts` vazio retorna `400`, e com `uploadId` inexistente retorna `404` com `errorCode: "UPLOAD_NOT_FOUND"`
- `DELETE /videos/uploads/{uploadId}` de um upload aberto retorna `204` e torna o mesmo `uploadId` inexistente nas chamadas seguintes
- Nenhuma resposta expõe o UUID interno do vídeo — o identificador público é o `publicSlug`, e a única chave `videoId`-endereçada devolvida é o `key` exigido pelo protocolo de upload

---

### SI-03.7 — Criar o runtime do worker em container separado

**Description:** Isola o processamento FFmpeg do processo da API em um container próprio, reaproveitando a mesma base de código, o mesmo grafo de dependências e as mesmas entidades — só o entrypoint e a imagem mudam.

**Technical actions:**

1. Criar `src/main.worker.ts` — chama `setDefaultBackendFactory(createPostgresBackend)` antes de `NestFactory.createApplicationContext(WorkerModule)`, que sobe o container de IoC sem nenhum listener de rede (per `phase-03-videos/TD-07`, `phase-03-videos/TD-01`)
2. Criar `src/worker.module.ts` importando `ConfigModule`, TypeORM, `QueueModule` e `StorageModule`, sem controllers (per `phase-03-videos/TD-07`)
3. Adicionar a segunda entrada de compilação em `nest-cli.json` preservando o bloco `assets` existente, para que o build da API continue copiando os templates de e-mail (per `phase-03-videos/TD-07`)
4. Criar `nestjs-project/Dockerfile.worker.dev` instalando FFmpeg via `apt` — sem binários npm, já que a imagem customizada existe de qualquer forma (per `phase-03-videos/TD-08`)
5. Adicionar o serviço `video-worker` em `compose.yaml` usando o mesmo contexto de build com o Dockerfile do worker, com `depends_on` de `db` e `minio`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação e DI do contexto standalone (config, TypeORM, fila, storage) | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.2 (storage), SI-03.3 (fila e seleção do backend PostgreSQL)

**Acceptance criteria:**

- O container do worker inicia sem expor porta HTTP e passa a consumir a fila `video`
- `ffmpeg -version` e `ffprobe -version` respondem dentro do container do worker
- O build da API continua emitindo os templates de e-mail da Fase 02 junto do bundle
- Derrubar o container do worker não afeta a disponibilidade das rotas da API

---

### SI-03.8 — Implementar o wrapper tipado de FFmpeg para metadados e thumbnail

**Description:** Encapsula as duas únicas operações de FFmpeg que a fase precisa — uma sondagem de metadados e a extração de um frame — atrás de uma interface tipada, lendo o objeto por HTTP em vez de baixar o arquivo inteiro.

**Technical actions:**

1. Criar `src/videos/processing/ffmpeg.service.ts` — spawn direto de `ffprobe -print_format json -show_format -show_streams` aceitando uma URL HTTP como input, sem `fluent-ffmpeg` (arquivado) e sem download prévio (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
2. Mapear a saída do `ffprobe` para um tipo `VideoMetadata` com exatamente `durationSeconds`, `width`, `height`, `sizeBytes`, `container`, `videoCodec` e `audioCodec` — `bitrate` e `frameRate` ficam deliberadamente de fora por não terem consumidor (per `### Data Model`)
3. Implementar `extractThumbnail()` — `ffmpeg` posicionado em **10% da duração**, um único frame, redimensionado para 1280x720 e codificado em JPEG; o percentual escala igual para vídeos curtos e longos e evita o frame preto de um timestamp fixo (per `### Events/Messages` passo 4)
4. Lançar um erro tipado com o código `NO_VIDEO_STREAM` quando o `ffprobe` não reporta nenhum stream de vídeo (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit: parsing da saída do `ffprobe` a partir de fixtures, cálculo do timestamp de 10%, branch sem stream de vídeo | `src/videos/processing/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration: sondagem e extração de frame contra um arquivo de vídeo real de fixture | `src/videos/processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — o FFmpeg só existe dentro da imagem do worker

**Acceptance criteria:**

- Um arquivo de vídeo válido produz duração, dimensões, container e codecs de vídeo e áudio preenchidos
- Um arquivo sem stream de vídeo produz o código de falha `NO_VIDEO_STREAM`
- O thumbnail gerado é um JPEG de 1280x720 correspondente ao frame em 10% da duração
- A sondagem de um arquivo grande transfere apenas uma fração do objeto, não o arquivo inteiro

---

### SI-03.9 — Implementar o processor `process-video` com política de falha e idempotência

**Description:** Fecha o processamento automático: consome o job da fila, sonda o objeto por HTTP, extrai metadados e thumbnail, promove o objeto para o bucket de mídia e conclui o vídeo em `READY` ou `FAILED` com motivo legível por máquina.

**Technical actions:**

1. Criar `src/videos/processing/video.processor.ts` — `@Processor('video')` estendendo `WorkerHost`, executando na ordem os seis passos de `### Events/Messages → Consumer steps`, começando pela transição para `PROCESSING` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
2. Presignar um `GetObject` do objeto de ingest e entregá-lo ao FFmpeg como input HTTP; se a sondagem por range falhar, refazer uma única vez com download local antes de declarar falha — um branch a mais que converte o único risco real da abordagem em sucesso lento (per `phase-03-videos/TD-09`)
3. Persistir os metadados extraídos, gravar o thumbnail em chave determinística no bucket de mídia e promover o objeto de ingest com um `CopyObject` que fixa o `ContentType` no destino, do qual playback e download dependem (per `phase-03-videos/TD-02`)
4. Aplicar a política de falha: `UnrecoverableError` para `NO_VIDEO_STREAM` (curto-circuita o orçamento de tentativas) e, no esgotamento do orçamento, `FAILED` com `processingError` `{ code, message }` preservando o objeto de ingest para diagnóstico e reprocessamento (per `phase-03-videos/TD-06`)
5. Registrar o processor em `WorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: transições de status, fallback de download local, branch terminal versus transitório (storage e FFmpeg mockados) | `src/videos/processing/video.processor.spec.ts` |
| `VideoProcessor` | Integration: job real contra MinIO e DB — vídeo termina `READY` com metadados, thumbnail e objeto promovido | `src/videos/processing/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.5 (o job é enfileirado no `complete`), SI-03.8 (wrapper de FFmpeg)

**Acceptance criteria:**

- Um job bem-sucedido deixa o vídeo em `READY` com duração, dimensões e codecs preenchidos e um thumbnail 1280x720 no bucket de mídia
- Um vídeo sem stream de vídeo termina em `FAILED` com `processingError.code` igual a `NO_VIDEO_STREAM` já na primeira tentativa, sem consumir as três
- Uma falha terminal preserva o objeto de ingest no bucket de uploads
- Reprocessar o mesmo vídeo sobrescreve as chaves de saída em vez de criar objetos duplicados
- O objeto promovido no bucket de mídia carrega o `contentType` registrado no vídeo

---

### SI-03.10 — Expor os endpoints de status, playback e download

**Route:** GET /videos/{publicSlug}, GET /videos/{publicSlug}/playback, GET /videos/{publicSlug}/download
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Autenticado e dono do vídeo, falhando fechado (per `### Authorization Matrix`); acesso anônimo só abre na Fase 05, junto do modelo de visibilidade da Fase 04

**Description:** Entrega a reprodução por streaming e o download com um único mecanismo — URLs presignadas de curta duração — mantendo a API fora do caminho dos bytes, e expõe o status do pipeline que o cliente consulta enquanto o processamento roda.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` — busca por `publicSlug` com checagem de propriedade e emissão de URLs presignadas pelo cliente **público** com TTL explícito: a de playback é limpa (o browser envia `Range` e a storage responde `206` nativamente) e a de download repete a mesma assinatura com `ResponseContentDisposition` derivado de `originalFilename` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-03`)
2. Bloquear playback e download enquanto `processingStatus` não for `READY`, lançando `VideoNotReadyException` (per `phase-03-videos/TD-05`)
3. Criar `src/videos/videos.controller.ts` com as três rotas de `### API Contracts` e seus DTOs de resposta, sob `JwtAuthGuard` mais o guard de propriedade, decoradas com `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`)
4. Registrar controller e serviço em `VideosModule` e regenerar o `openapi.json` commitado (`npm run openapi:export`) cobrindo os sete endpoints da fase (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: branches de propriedade, bloqueio fora de `READY`, TTL explícito e `Content-Disposition` derivado do `originalFilename` | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.4 (entidade e exceções), SI-03.9 (só há o que reproduzir depois que o processamento promove o objeto)

**Acceptance criteria:**

- `GET /videos/{publicSlug}` do dono retorna `200` com `processingStatus` e os metadados extraídos, nulos enquanto o processamento não concluiu
- `GET /videos/{publicSlug}/playback` antes de `READY` retorna `409` com `errorCode: "VIDEO_NOT_READY"`
- A URL de playback aceita requisições com `Range` e devolve `206` sem que os bytes passem pela API
- A URL de download entrega o arquivo com `Content-Disposition: attachment` e o nome de arquivo original do vídeo
- Um `publicSlug` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`, e um vídeo de outro dono retorna `403` com `errorCode: "VIDEO_ACCESS_DENIED"`
- Uma URL de playback expirada deixa de dar acesso ao objeto
- O `openapi.json` commitado descreve as sete rotas da fase

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — internal only; never appears in URLs or OpenAPI responses (per `phase-03-videos/TD-10`) |
| publicSlug | varchar(11) | UNIQUE, NOT NULL — 11-char base64url from `node:crypto` `randomBytes` (per `phase-03-videos/TD-10`) |
| title | varchar(255) | NOT NULL — born with default equal to `filename` without extension (per `validation.md` AMB-4) |
| channelId | uuid | NOT NULL, FK → `channels.id` — derived from the authenticated owner's session, never from the request body (per `validation.md` AMB-4) |
| processingStatus | enum | NOT NULL, default `PENDING_UPLOAD` (per `phase-03-videos/TD-05`) |
| processingError | jsonb | nullable — carries a stable machine-readable reason code for the frontend plus a human message for the owner (per `phase-03-videos/TD-05`); see `### Error Catalog → Processing failure reason codes` |
| originalFilename | varchar(255) | NOT NULL — the `filename` submitted at initiate (per `validation.md` AMB-4); source of the download `filename` in `Content-Disposition` (per `phase-03-videos/TD-11`) |
| contentType | varchar(255) | NOT NULL — the `contentType` submitted at initiate (per `validation.md` AMB-4); set on the media object by the worker so playback/download serve it correctly (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`) |
| sizeBytes | bigint | NOT NULL — declared at initiate (per `validation.md` AMB-4), reconciled from `ffprobe` during processing (per `validation.md` AMB-1) |
| uploadId | varchar(255) | nullable — the S3 `UploadId` returned by `CreateMultipartUpload`; cleared on complete/abort (per `phase-03-videos/TD-04`) |
| durationSeconds | int | nullable until `READY` — extracted by `ffprobe` (per `validation.md` AMB-1) |
| width | int | nullable until `READY` — extracted by `ffprobe` (per `validation.md` AMB-1) |
| height | int | nullable until `READY` — extracted by `ffprobe` (per `validation.md` AMB-1) |
| container | varchar(50) | nullable until `READY` — extracted by `ffprobe` (per `validation.md` AMB-1) |
| videoCodec | varchar(50) | nullable until `READY` — extracted by `ffprobe`; enables detecting a container the browser cannot play, since this phase does not transcode (per `validation.md` AMB-1) |
| audioCodec | varchar(50) | nullable until `READY` — extracted by `ffprobe` (per `validation.md` AMB-1) |
| created_at | timestamptz | `@CreateDateColumn()`, default now() |
| updated_at | timestamptz | `@UpdateDateColumn()` |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (many-to-one, both sides defined).
**Indexes:** unique on `publicSlug`; FK index on `channelId`.

**`processingStatus` values** (per `phase-03-videos/TD-05`): `PENDING_UPLOAD` → `UPLOADING` → `PROCESSING` → `READY` | `FAILED`.

| Value | Written when |
|-------|--------------|
| `PENDING_UPLOAD` | the `CreateMultipartUpload` handshake pre-registers the video (this is the "pré-cadastro automático") |
| `UPLOADING` | the first part is signed |
| `PROCESSING` | the worker picks the job up |
| `READY` | processing succeeded — the video is only listable/playable in this state |
| `FAILED` | processing failed terminally; `processingError` is populated |

**Excluded metadata:** `bitrate` and `frameRate` are deliberately **not** persisted — no consumer (per `validation.md` AMB-1).

**Storage keys are derived, not stored.** Object keys are `videoId`-addressed and deterministic, so a re-run overwrites rather than duplicating (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`); ownership changes never touch storage. The ingest object lives in the uploads bucket, the promoted video and its thumbnail in the media bucket — one thumbnail per video, 1280x720 JPEG (per `validation.md` AMB-2). No key column exists on `Video`.

**Naming note (deliberate divergence).** The field names above are transcribed verbatim from `phase-03-videos/TD-05`, `phase-03-videos/TD-10`, and the `validation.md` clarifications, which use camelCase (`processingStatus`, `publicSlug`, `durationSeconds`, `sizeBytes`, `videoCodec`, `audioCodec`, `channelId`). The existing `Channel` entity uses snake_case property names (`user_id`, `created_at`). This plan does **not** silently rename either side: the implementer must map camelCase entity properties to snake_case DB columns via explicit `@Column({ name: '...' })`, keeping the TD-specified names as the TypeScript surface and the project's snake_case convention in the schema.

### API Contracts

Backend tier only. The BFF Route Handlers under `next-frontend/app/api/videos/**` and the browser `@uppy/aws-s3` client are **deferred to a future frontend slice** (per `phase-03-videos/TD-04` Revisions 2026-08-15, `validation.md` IC-1/IC-2) — the shapes below are the contract that slice must honour, and are verified in this slice by E2E against the API.

The three control-plane calls below are shaped to satisfy `@uppy/aws-s3`'s companion-less callback contract (`createMultipartUpload` → `{ uploadId, key }`, `signPart` → `{ url, headers }`, `completeMultipartUpload` → `{ location }`), so the future client needs no adapter. Part bytes never transit the API — the browser `PUT`s each part straight to object storage against a presigned URL (per `phase-03-videos/TD-04`).

#### POST /videos/uploads (SI-03.6)

Pre-registers the video as a draft and opens the S3 multipart upload — the "pré-cadastro automático" of `phase-03-videos/TD-05`.

**Request headers:**
- Content-Type: application/json
- Authorization: bearer access token — the owning `channelId` is resolved from the session, never from the body (per `validation.md` AMB-4)

**Request body:**
- filename: string, required
- sizeBytes: number, required
- contentType: string, required

**Response 201:**
- uploadId: string — the S3 `UploadId` (required by `@uppy/aws-s3` `createMultipartUpload`)
- key: string — the `videoId`-addressed ingest object key chosen by the API; the client never chooses it (per `phase-03-videos/TD-02`)
- publicSlug: string — the 11-char handle used by every subsequent route (per `phase-03-videos/TD-10`)

**Error responses:**
- 400 validation error: when `filename`, `sizeBytes`, or `contentType` is missing or malformed
- 401 INVALID_TOKEN: when the access token is absent or invalid

---

#### GET /videos/uploads/{uploadId}/parts/{partNumber} (SI-03.6)

Presigns a single `UploadPart` request. Transitions `processingStatus` to `UPLOADING` on the first part (per `phase-03-videos/TD-05`).

**Request headers:**
- Authorization: bearer access token

**Request query parameters:** _None._

**Response 200:**
- url: string — presigned `UploadPart` URL, signed by the **public-endpoint** client so the signature is browser-valid (per `phase-03-videos/TD-03`)
- headers: object — headers the client must replay on the `PUT`

**Error responses:**
- 400 validation error: when `partNumber` is not a positive integer (`@uppy/aws-s3` `partNumber` is 1-based and never zero)
- 401 INVALID_TOKEN: when the access token is absent or invalid
- 403 VIDEO_ACCESS_DENIED: when the caller does not own the video behind `uploadId`
- 404 UPLOAD_NOT_FOUND: when `uploadId` matches no open upload
- 409 INVALID_UPLOAD_STATE: when the video is no longer in `PENDING_UPLOAD` or `UPLOADING`

---

#### POST /videos/uploads/{uploadId}/complete (SI-03.6)

Finalizes the multipart upload and enqueues the processing job.

**Request headers:**
- Content-Type: application/json
- Authorization: bearer access token

**Request body:**
- parts: array, required — S3-style `{ ETag, PartNumber }` entries collected by the client from its own `PUT` responses, in `PartNumber` order

**Response 200:**
- location: string — the completed object location (required by `@uppy/aws-s3` `completeMultipartUpload`)

**Error responses:**
- 400 validation error: when `parts` is empty or an entry is missing `ETag` / `PartNumber`
- 401 INVALID_TOKEN: when the access token is absent or invalid
- 403 VIDEO_ACCESS_DENIED: when the caller does not own the video behind `uploadId`
- 404 UPLOAD_NOT_FOUND: when `uploadId` matches no open upload
- 409 INVALID_UPLOAD_STATE: when the video is no longer in `PENDING_UPLOAD` or `UPLOADING`

---

#### DELETE /videos/uploads/{uploadId} (SI-03.6)

Aborts the multipart upload (`AbortMultipartUploadCommand`), releasing the incomplete parts.

**Request headers:**
- Authorization: bearer access token

**Response 204:** No content.

**Error responses:**
- 401 INVALID_TOKEN: when the access token is absent or invalid
- 403 VIDEO_ACCESS_DENIED: when the caller does not own the video behind `uploadId`
- 404 UPLOAD_NOT_FOUND: when `uploadId` matches no open upload

---

#### GET /videos/{publicSlug} (SI-03.10)

Returns the video's pipeline state and extracted metadata. This is the endpoint the future client polls while processing runs.

**Request headers:**
- Authorization: bearer access token

**Response 200:**
- publicSlug: string
- title: string
- processingStatus: string — one of `PENDING_UPLOAD` | `UPLOADING` | `PROCESSING` | `READY` | `FAILED` (per `phase-03-videos/TD-05`)
- processingError: object or null — `{ code, message }`, populated only in `FAILED`
- durationSeconds: number or null
- width: number or null
- height: number or null
- sizeBytes: number
- container: string or null
- videoCodec: string or null
- audioCodec: string or null

**Error responses:**
- 401 INVALID_TOKEN: when the access token is absent or invalid
- 403 VIDEO_ACCESS_DENIED: when the caller does not own the video (per `validation.md` AMB-3)
- 404 VIDEO_NOT_FOUND: when `publicSlug` matches no video

---

#### GET /videos/{publicSlug}/playback (SI-03.10)

Mints a fresh short-lived presigned `GetObject` URL for streaming. The URL is bare — the browser sends `Range` and object storage answers `206` natively, so the API stays out of the data path (per `phase-03-videos/TD-11`). A dedicated endpoint exists so the TTL can be tuned without a client change.

**Request headers:**
- Authorization: bearer access token

**Response 200:**
- url: string — presigned `GetObject` URL against the media bucket, signed by the public-endpoint client (per `phase-03-videos/TD-03`)
- expiresIn: number — TTL in seconds, set explicitly rather than relying on the presigner's 900s default

**Error responses:**
- 401 INVALID_TOKEN: when the access token is absent or invalid
- 403 VIDEO_ACCESS_DENIED: when the caller does not own the video (per `validation.md` AMB-3)
- 404 VIDEO_NOT_FOUND: when `publicSlug` matches no video
- 409 VIDEO_NOT_READY: when `processingStatus` is not `READY` (per `phase-03-videos/TD-05`)

---

#### GET /videos/{publicSlug}/download (SI-03.10)

Same object, presigned a second time with a `Content-Disposition` override so the browser saves instead of streams (per `phase-03-videos/TD-11`). The override is serialized as the `response-content-disposition` query parameter and is covered by the signature.

**Request headers:**
- Authorization: bearer access token

**Response 200:**
- url: string — presigned `GetObject` URL carrying `ResponseContentDisposition: attachment; filename="..."` derived from `originalFilename`
- expiresIn: number — TTL in seconds, set explicitly

**Error responses:**
- 401 INVALID_TOKEN: when the access token is absent or invalid
- 403 VIDEO_ACCESS_DENIED: when the caller does not own the video (per `validation.md` AMB-3)
- 404 VIDEO_NOT_FOUND: when `publicSlug` matches no video
- 409 VIDEO_NOT_READY: when `processingStatus` is not `READY` (per `phase-03-videos/TD-05`)

---

#### Validation Rules — upload control plane

- `filename`: required, non-empty string; the extension is stripped to derive the default `title` (per `validation.md` AMB-4)
- `sizeBytes`: required, positive integer
- `contentType`: required, non-empty string
- `partNumber`: required, integer ≥ 1 (`@uppy/aws-s3` sends 1-based part numbers)
- `parts`: required, non-empty array; each entry requires `ETag` and `PartNumber`

**Identifier exposure note.** `phase-03-videos/TD-10` keeps the UUID PK internal — every route above is addressed by `publicSlug`. The one exception is the `key` returned by `POST /videos/uploads`, which is `videoId`-addressed by `phase-03-videos/TD-02` and must be handed to the client because `@uppy/aws-s3` requires it. This is an upload-protocol artifact, not a public identifier; no other response exposes the UUID.

### Authorization Matrix

Every route in this phase is **owner-only and fails closed**. Per `validation.md` AMB-3, every video created in Phase 03 is a draft by construction — the `rascunho → publicação` flow only arrives in Fase 04 — so the delivery routes carry an authentication guard plus an ownership check. Anonymous access opens in **Fase 05**, together with Fase 04's `público/unlisted` visibility model; it is deliberately absent here.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos/uploads | ✗ | ✓ (becomes the owner) | ✓ |
| GET /videos/uploads/{uploadId}/parts/{partNumber} | ✗ | ✗ | ✓ |
| POST /videos/uploads/{uploadId}/complete | ✗ | ✗ | ✓ |
| DELETE /videos/uploads/{uploadId} | ✗ | ✗ | ✓ |
| GET /videos/{publicSlug} | ✗ | ✗ | ✓ |
| GET /videos/{publicSlug}/playback | ✗ | ✗ | ✓ |
| GET /videos/{publicSlug}/download | ✗ | ✗ | ✓ |

**Ownership definition:** the caller's session resolves to a `Channel`, and `Video.channelId` must equal that channel's `id`. `POST /videos/uploads` is the one route with no pre-existing video to own — any authenticated user with a channel may call it, and the created video is bound to their channel (per `validation.md` AMB-4).

**Delegation.** The ownership check is a business rule and lives in the videos service; the guard injects and calls it rather than reading `channelId` off the request itself (per `.claude/rules/nestjs-layer-separation.md`).

**Presigned URLs are bearer capabilities.** Once minted, a playback or download URL grants access to anyone holding it until it expires — object storage performs no per-request authorization. This is the accepted trade-off of `phase-03-videos/TD-11` Option B, and the reason the TTL is short and explicitly set; per-range authorization would require Option A (proxying bytes through the API), which the phase's governing constraint rules out.

---

### Error Catalog

**Response shape** (inherited convention, `phase-02-auth/TD-07`): `{ statusCode, error, message }`, emitted by `DomainExceptionFilter`, where `error` carries the machine-readable `errorCode`. New exceptions extend the existing `DomainException` base.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicSlug` matches no video |
| UPLOAD_NOT_FOUND | 404 | `uploadId` matches no open multipart upload (never opened, or already completed/aborted) |
| VIDEO_ACCESS_DENIED | 403 | The authenticated caller is not the owner of the target video (per `validation.md` AMB-3) |
| INVALID_UPLOAD_STATE | 409 | A sign-part or complete call arrives when `processingStatus` is no longer `PENDING_UPLOAD` or `UPLOADING` |
| VIDEO_NOT_READY | 409 | Playback or download requested while `processingStatus` is not `READY` (per `phase-03-videos/TD-05`) |

Reused from `phase-02-auth`: `INVALID_TOKEN` (401) covers an absent or invalid access token on every route above; validation failures continue to surface through the existing `ValidationExceptionFilter` as 400.

#### Processing failure reason codes

These are **not** HTTP errors — they are the stable machine-readable codes stored in `Video.processingError.code` when `processingStatus` becomes `FAILED`, for the frontend to switch on (per `phase-03-videos/TD-05`). The human-readable half is stored alongside in `processingError.message`.

| code | Retry behavior | Trigger |
|------|----------------|---------|
| NO_VIDEO_STREAM | Terminal — raised as `UnrecoverableError`, short-circuits the remaining retry budget | `ffprobe` reports the uploaded object contains no video stream (per `phase-03-videos/TD-06`) |
| _undetermined — no TD names a code for retry exhaustion_ | Terminal after 3 attempts + exponential backoff | The job failed transiently and exhausted its retry budget (per `phase-03-videos/TD-06`). The code string is not fixed by any TD; the implementer must not invent a contract value here without a `/decide` cycle |

**The source object survives terminal failure.** `phase-03-videos/TD-06` is explicit: do **not** delete the uploaded ingest object when processing fails terminally — it is needed both for diagnosis and for a later reprocess attempt. Orphan cleanup is left to the bucket lifecycle rule of `phase-03-videos/TD-02` on a longer horizon. Likewise `removeOnFail: false` keeps failed jobs inspectable in the queue.

### Events/Messages

One queue, one job type. The broker is **BullMQ v6 on its PostgreSQL backend** — no Redis service is added to the Compose stack (per `phase-03-videos/TD-01`).

#### process-video

**Queue:** `video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** the upload control plane, on successful `CompleteMultipartUpload` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
**Consumer:** `@Processor('video')` extending `WorkerHost`, running in the separate worker container (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`)
**Trigger:** the multipart upload completes and the ingest object is durable in the uploads bucket
**Delivery semantics:** at-least-once — 3 attempts with exponential backoff, deduplicated on enqueue by `jobId = videoId`, made idempotent by deterministic output keys (per `phase-03-videos/TD-06`)

**Job options** (per `phase-03-videos/TD-06`):

| Option | Value | Why |
|--------|-------|-----|
| `jobId` | `videoId` | Enqueue deduplication |
| `attempts` | `3` | Retry budget for transient failures |
| `backoff` | exponential | Spaces retries of transient failures |
| `removeOnComplete` | `true` | Keeps the queue small |
| `removeOnFail` | `false` | Failures stay inspectable |

**Two failure classes, treated differently.** Deterministic failures (`ffprobe` reports no video stream and similar) throw `UnrecoverableError`, which moves the job straight to `failed` even with retries remaining. Everything else consumes the retry budget normally. This split is the whole point of `phase-03-videos/TD-06`.

**Re-enqueue after success is by design.** Because `removeOnComplete: true` releases the completed job's id, adding the same `videoId` again succeeds — that is the reprocess path. Idempotency therefore cannot rely on `jobId` alone; it comes from deterministic output keys, which a re-run overwrites rather than duplicating.

**Consumer steps** (each step's TD in parentheses):

1. Set `processingStatus` to `PROCESSING` (`phase-03-videos/TD-05`).
2. Presign a `GetObject` URL for the ingest object and hand it to `ffprobe`/`ffmpeg` as an HTTP input, so the worker reads a header plus one frame over HTTP range requests instead of downloading 10GB to local disk (`phase-03-videos/TD-09`).
3. Extract `durationSeconds`, `width`, `height`, `sizeBytes`, `container`, `videoCodec`, `audioCodec` (`validation.md` AMB-1).
4. Extract one frame at **10% of the duration** and encode it as a 1280x720 JPEG thumbnail (`validation.md` AMB-2). The percentage scales identically for short and long videos and avoids the black/fade-in frame a fixed timestamp produces. This is a **replaceable default** — Fase 04's custom thumbnail overwrites it.
5. Promote the object from the uploads bucket to the media bucket with a single `CopyObject`, setting `ContentType` on the destination (`phase-03-videos/TD-02`); playback and download depend on it being correct.
6. Set `processingStatus` to `READY`, or to `FAILED` with `processingError` populated (`phase-03-videos/TD-05`).

**HTTP-input fallback.** If the HTTP-range probe fails — a pathological container layout, a storage-side range limitation — retry the job once with a local download before declaring `FAILED`. `phase-03-videos/TD-09` keeps this branch explicitly: it costs one conditional and converts the only real risk of the presigned-GET approach into a slow success rather than a failure.

---

## Dependency Map

```
SI-03.1 (root — MinIO + config de storage)
└── SI-03.2 — depends on SI-03.1 (endpoints e buckets vêm do config)
    ├── SI-03.5 — depends on SI-03.2 + SI-03.3 + SI-03.4 (control plane precisa de storage, fila e entidade)
    │   ├── SI-03.6 — depends on SI-03.5 (controller expõe a regra do serviço)
    │   └── SI-03.9 — depends on SI-03.5 + SI-03.8 (o job só existe depois do complete; o pipeline precisa do FFmpeg)
    │       └── SI-03.10 — depends on SI-03.4 + SI-03.9 (só há playback depois da promoção para o bucket de mídia)
    └── SI-03.7 — depends on SI-03.2 + SI-03.3 (worker consome storage e fila)
        └── SI-03.8 — depends on SI-03.7 (FFmpeg só existe na imagem do worker)
SI-03.3 (root — fila BullMQ sobre PostgreSQL)
SI-03.4 (root — domínio de vídeo: entidade, slug e exceções)
```

**Roots paralelizáveis:** SI-03.1, SI-03.3 e SI-03.4 não dependem de nada e podem ser implementados em qualquer ordem. O primeiro ponto de convergência é SI-03.5.

**Caminho crítico:** SI-03.1 → SI-03.2 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10.

---

## Deliverables

- [ ] SI-03.1 — Provisionar MinIO no Compose e a configuração de storage
- [ ] SI-03.2 — Implementar o módulo de storage com clientes S3 interno e público
- [ ] SI-03.3 — Provisionar a fila `video` com BullMQ v6 sobre PostgreSQL
- [ ] SI-03.4 — Modelar o domínio de vídeo: entidade, migration, `publicSlug` e exceções
- [ ] SI-03.5 — Implementar o serviço do control plane de upload multipart
- [ ] SI-03.6 — Expor os endpoints do control plane de upload
- [ ] SI-03.7 — Criar o runtime do worker em container separado
- [ ] SI-03.8 — Implementar o wrapper tipado de FFmpeg para metadados e thumbnail
- [ ] SI-03.9 — Implementar o processor `process-video` com política de falha e idempotência
- [ ] SI-03.10 — Expor os endpoints de status, playback e download

**Full test suites:**

- [ ] Backend unit tests pass (`cd nestjs-project && npm test`)
- [ ] Backend integration tests pass (`cd nestjs-project && npm run test:integration`)
- [ ] E2E tests pass (`cd nestjs-project && npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && npm run lint`)

_`next-frontend` é consumidor apenas nesta fatia — nenhum artefato de frontend é implementado aqui, logo não há suíte de frontend a rodar (per `context.md` § Testing Requirements)._
