---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-16T16:43:58-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-16T16:27:42-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-04 commits to browser-side uppy while the slice declares no frontend artifact implemented"
    resolved_by: phase-03-videos/TD-04
  - id: IC-2
    status: resolved
    summary: "TD-04 revision põe control plane em Route Handlers do Next, mas slice diz 'no frontend artifact'"
    resolved_by: phase-03-videos/TD-04
  - id: ICC-1
    status: resolved
    summary: "TD-04 upload control plane 'na API' vs inherited strict-BFF (Route Handler as only NestJS caller)"
    resolved_by: phase-03-videos/TD-04
  - id: AMB-1
    status: resolved
    summary: "'metadados' não enumera quais campos além de duração são extraídos/persistidos"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Política de seleção do frame do thumbnail e formato de saída não especificados"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Quem pode fazer streaming/download em uma fase sem modelo de visibilidade"
    resolved_by: clarification
  - id: AMB-4
    status: resolved
    summary: "Payload e nulabilidade do pré-cadastro (title/channel) não fixados por nenhum TD"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Queue Backend and Broker"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Bucket and Key Organization in Object Storage"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — MinIO Endpoint Topology"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — 10GB Upload Strategy"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Status Model"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Processing Failure, Retry, and Idempotency Policy"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Where and How the Video Worker Runs"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — FFmpeg Integration"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — How the Worker Reads a 10GB Object"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Video Delivery — Streaming Playback and Download"
    resolved_by: phase-03-videos/TD-11
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-04)_ — Propriedade da metade cliente de TD-04 fixada: **esta slice entrega apenas o control plane + storage + worker**. "Upload de até 10GB funcional" é verificado por E2E contra a API (`CreateMultipartUpload` → partes assinadas → `Complete` → job enfileirado), sem cliente browser. `uppy` e `@uppy/aws-s3@^5` foram **removidos** do campo `**Libraries:**` de TD-04 e passam a ser propriedade da futura slice de frontend, que consome este TD. Registrado como `**Revisions:**` em TD-04 (entrada 2026-08-15). Nota: as entradas `uppy` / `@uppy/aws-s3` permanecem em `library-refs.md` como cache já materializado — inofensivas aqui e reaproveitáveis pela slice de frontend.

- **IC-2** _(resolved_by phase-03-videos/TD-04)_ — Fronteira do BFF fixada: **as três Route Handlers sob `app/api/videos/**` também ficam adiadas** para a futura slice de frontend, junto com o cliente browser. Esta slice entrega apenas o control plane NestJS + storage + worker, e "upload de até 10GB funcional" continua verificado por E2E contra a API. Consequência: `## Scope → Affected subprojects` (`next-frontend` consumer-only) e `## Testing Requirements → next-frontend` ("no frontend artifact is implemented here") **permanecem corretos como escritos** — não há edição de escopo nem rerun de `/plan-context` pendente. A revisão de BFF proxying registrada anteriormente descreve o contrato que a slice de frontend deve honrar quando chegar, não trabalho desta slice. Registrado como `**Revisions:**` em TD-04 (segunda entrada de 2026-08-15). Decisão permanece **B**.

- **AMB-4** _(resolved_by clarification)_ — Contrato do pré-cadastro fixado: o endpoint de `initiate` aceita **apenas** `filename`, `sizeBytes` e `contentType`; `channelId` é derivado da sessão autenticada do dono (nunca do corpo da requisição). Na entidade `Video`, `title` nasce **NOT NULL** com default igual ao `filename` sem extensão — nada de coluna nullable, e nenhum consumidor precisa tratar `NULL` até a Fase 04. Isso honra o "automático" da capability (o pré-cadastro não exige formulário, que seria UI fora do escopo desta slice) e mantém a Fase 04 como única dona da edição de metadados, que sobrescreve o título derivado. Colunas da criação: `title` NOT NULL, `processingStatus` NOT NULL = `PENDING_UPLOAD` (TD-05), `channelId` NOT NULL FK, `publicSlug` UNIQUE NOT NULL (TD-10). Consumido por `/plan-build` ao derivar o DTO do handshake de TD-04 e a migration da entidade `Video` (complementa AMB-1, que fixou os campos de metadados extraídos por `ffprobe`).

- **ICC-1** _(resolved_by phase-03-videos/TD-04)_ — Sem conflito real: TD-04 já continha a `**Cross-layer note on the BFF rule:**` decidindo que as três chamadas de control plane passam por Route Handlers do Next sob `app/api/videos/**`, e que apenas o trecho browser→object storage escapa do BFF. O problema era de **propagação**, não de decisão — `decisions-detail-reader` só carrega `**Recommendation:**` + `**Libraries:**` para o `context.md`, então a restrição era invisível para `/plan-build`. Resolvido com `**Revisions:**` em TD-04 (entrada 2026-08-15), que é surfaceada pelo reader e agora aparece no `## Decisions Detail` do `context.md`. Decisão permanece **B**; strict-BFF preservado.

- **AMB-1** _(resolved_by clarification)_ — Conjunto de metadados extraídos por `ffprobe` e persistidos na entidade `Video` fixado em **núcleo + codecs**: `durationSeconds`, `width`, `height`, `sizeBytes`, `container`, `videoCodec`, `audioCodec`. Cobre o player da Fase 05 (duração + aspect ratio), o painel da Fase 04 e o planejamento de storage; os campos de codec permitem detectar upload em formato não reproduzível no browser — risco real, já que a Fase 03 não transcodifica (TD-08 Option D explicitamente rejeitada). `bitrate` e `frameRate` ficam **fora** por ausência de consumidor. Consumido por `/plan-build` ao derivar a migration e a entidade `Video`.

- **AMB-2** _(resolved_by clarification)_ — Política de thumbnail fixada: **um** arquivo por vídeo, frame extraído a **10% da duração**, saída **1280x720 JPEG**. O percentual escala igual para vídeos curtos e longos e evita o frame preto/fade-in que o timestamp fixo produz. Este é o **default substituível** — a Fase 04 entrega "thumbnail customizada", que sobrescreve o gerado aqui. Variantes de tamanho (ex.: 320x180 para o grid da home) ficam para a Fase 07, que é quem introduz o grid.

- **AMB-3** _(resolved_by clarification)_ — Postura de autorização das rotas de entrega na Fase 03: **restrito ao dono do canal**. Todo vídeo desta fase é rascunho por construção (a capability de pré-cadastro cria o registro como rascunho e o fluxo `rascunho → publicação` só chega na Fase 04), portanto as rotas que emitem URL presignada de streaming e de download levam guard de autenticação + checagem de ownership. Falha fechado. A abertura para acesso anônimo acontece na **Fase 05**, junto com o modelo de visibilidade `público/unlisted` da Fase 04. Consumido por `/plan-build` ao derivar os guards das rotas de TD-11.

- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decidido: **B** — BullMQ v6 com backend PostgreSQL. Libraries: `bullmq@^6`, `@nestjs/bullmq@^11`.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decidido: **B** — dois buckets (`streamtube-uploads` ingest / `streamtube-media` derivado), chaves endereçadas por `videoId`. Libraries: `@aws-sdk/client-s3@^3`.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decidido: **A** — endpoint interno + público, dois clients S3 (o de presign não faz I/O). Libraries: `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decidido: **B** — multipart S3 presignado com control plane na API + cliente `@uppy/aws-s3`. Libraries: `@aws-sdk/s3-request-presigner@^3`, `uppy`, `@uppy/aws-s3@^5`.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decidido: **B** — eixo `processingStatus` ortogonal aos campos de publicação da Fase 04.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decidido: **A** — 3 tentativas + backoff, `UnrecoverableError` para falhas determinísticas, `jobId = videoId`.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decidido: **B** — container separado, mesmo codebase e imagem, entrypoint `createApplicationContext`.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decidido: **B** — `spawn` direto de `ffmpeg`/`ffprobe` + wrapper tipado fino (`fluent-ffmpeg` está arquivado). FFmpeg do sistema via `apt`, sem dependência npm.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decidido: **B** — GET presignado + range seeking HTTP, com fallback para download local se o probe falhar. Libraries: `@aws-sdk/s3-request-presigner@^3`.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decidido: **B** — slug base64url de 11 chars via `crypto.randomBytes` em coluna `UNIQUE`. Sem dependência npm (`node:crypto`).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decidido: **B** — GET presignado de vida curta (`Range`/`206` nativos), override de `Content-Disposition` para download. Libraries: `@aws-sdk/s3-request-presigner@^3`.
</content>
