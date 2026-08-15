---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos.e2e-spec.ts
---

# Video status, playback e download — Test Plan

## Application Overview

As três rotas endereçadas por `publicSlug` entregam o estado do pipeline e a distribuição do arquivo: `GET /videos/{publicSlug}` devolve `processingStatus` e os metadados extraídos pelo `ffprobe` (nulos enquanto o processamento não concluiu) — é o endpoint que o cliente consulta em polling enquanto o worker roda; `GET /videos/{publicSlug}/playback` mina uma URL presignada `GetObject` curta e limpa contra o bucket de mídia, para que o browser envie `Range` e o storage responda `206` nativamente, mantendo a API fora do caminho dos bytes; `GET /videos/{publicSlug}/download` repete a mesma assinatura acrescentando `ResponseContentDisposition: attachment; filename="..."` derivado do `originalFilename`, serializado como query parameter coberto pela assinatura. Playback e download ficam bloqueados com `VIDEO_NOT_READY` enquanto `processingStatus` não for `READY`. Toda rota é owner-only e falha fechada — acesso anônimo só abre na Fase 05, junto do modelo de visibilidade da Fase 04. URLs presignadas são capacidades ao portador: uma vez emitidas, valem até expirar, e é por isso que o TTL é curto e explicitamente definido.

## Test Scenarios

### 1. GET /videos/{publicSlug}

**Setup:** `beforeEach` trunca `videos`, `channels` e `users` via `dataSource.query('DELETE FROM ...')`; bootstrap do módulo de teste com `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo os globals de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`); seed de dois usuários confirmados com canais próprios (o dono e o não-dono) e seus access tokens; vídeos semeados em estados controlados de `processingStatus`.

#### 1.1. status-do-dono-retorna-metadados-e-nulos-antes-de-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `GET /videos/{publicSlug}` autenticado como dono, sobre um vídeo em `PROCESSING`
    - expect: status `200`
    - expect: `processingStatus` é `"PROCESSING"` e `processingError` é `null`
    - expect: `durationSeconds`, `width`, `height`, `container`, `videoCodec` e `audioCodec` são `null` — os metadados só existem depois do processamento
    - expect: `publicSlug`, `title` e `sizeBytes` vêm preenchidos, e nenhum UUID interno aparece no corpo
  2. `GET /videos/{publicSlug}` autenticado como dono, sobre um vídeo em `READY` com metadados persistidos
    - expect: status `200` com `durationSeconds`, `width`, `height`, `container`, `videoCodec` e `audioCodec` preenchidos
  3. `GET /videos/{publicSlug}` autenticado como dono, sobre um vídeo em `FAILED`
    - expect: status `200` com `processingStatus` igual a `"FAILED"` e `processingError` no formato `{ code, message }`

#### 1.2. acesso-negado-slug-inexistente-outro-dono-e-anonimo

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `GET /videos/{publicSlug inexistente}` autenticado
    - expect: status `404` com `error` igual a `"VIDEO_NOT_FOUND"` no formato `{ statusCode, error, message }`
  2. `GET /videos/{publicSlug}` autenticado como o não-dono, sobre o vídeo do dono
    - expect: status `403` com `error` igual a `"VIDEO_ACCESS_DENIED"`
    - expect: o corpo não vaza nenhum metadado do vídeo alheio
  3. `GET /videos/{publicSlug}`, `.../playback` e `.../download` sem header `Authorization`
    - expect: status `401` com `error` igual a `"INVALID_TOKEN"` nas três — anônimo não tem acesso nesta fase

---

### 2. GET /videos/{publicSlug}/playback

**Setup:** o mesmo bootstrap do grupo 1, mais um vídeo do dono em `READY` com o objeto promovido e presente no bucket de mídia, e um vídeo do dono em `PROCESSING`.

#### 2.1. playback-antes-de-ready-retorna-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `GET /videos/{publicSlug}/playback` autenticado como dono, sobre o vídeo em `PROCESSING`
    - expect: status `409` com `error` igual a `"VIDEO_NOT_READY"`
  2. Repetir sobre vídeos em `PENDING_UPLOAD`, `UPLOADING` e `FAILED`
    - expect: status `409` com `error` igual a `"VIDEO_NOT_READY"` em todos — só `READY` libera a reprodução
    - expect: nenhuma URL presignada é emitida em nenhum dos casos bloqueados

#### 2.2. playback-url-aceita-range-e-devolve-206

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `GET /videos/{publicSlug}/playback` autenticado como dono, sobre o vídeo em `READY`
    - expect: status `200` com `url` (string) e `expiresIn` (número), com `expiresIn` explicitamente definido e diferente do default de 900s do presigner
    - expect: a `url` aponta para o endpoint **público** do storage e para o bucket de mídia
  2. Requisitar a `url` devolvida diretamente contra o storage, com header `Range: bytes=0-1023`
    - expect: status `206` com `Content-Range` cobrindo a faixa pedida e corpo do tamanho solicitado
    - expect: os bytes vieram do storage sem passar pela API — nenhuma rota da API foi tocada nessa requisição
  3. Requisitar a mesma `url` sem header `Range`
    - expect: status `200` e o `Content-Type` registrado no vídeo

#### 2.3. playback-url-expirada-perde-acesso

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. Emitir uma URL de playback com TTL curto e aguardar o TTL vencer (ou emiti-la com o TTL de teste reduzido via config)
    - expect: a requisição da URL expirada contra o storage é rejeitada — o acesso ao objeto não sobrevive ao vencimento
  2. `GET /videos/{publicSlug}/playback` de novo, autenticado como dono
    - expect: status `200` com uma `url` nova e distinta da anterior
    - expect: a URL nova volta a dar acesso ao objeto

---

### 3. GET /videos/{publicSlug}/download

**Setup:** o mesmo bootstrap do grupo 2, com o vídeo em `READY` carregando um `originalFilename` conhecido.

#### 3.1. download-url-entrega-attachment-com-nome-original

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `GET /videos/{publicSlug}/download` autenticado como dono, sobre o vídeo em `READY`
    - expect: status `200` com `url` (string) e `expiresIn` (número) explicitamente definido
    - expect: a `url` carrega o query parameter `response-content-disposition` e a assinatura o cobre
  2. Requisitar a `url` devolvida diretamente contra o storage
    - expect: a resposta traz `Content-Disposition: attachment` com `filename` igual ao `originalFilename` do vídeo
    - expect: o `Content-Type` servido é o registrado no vídeo
  3. `GET /videos/{publicSlug}/download` sobre um vídeo que não está em `READY`
    - expect: status `409` com `error` igual a `"VIDEO_NOT_READY"`

---

### 4. Contrato OpenAPI publicado

**Setup:** o mesmo bootstrap do grupo 1; o `openapi.json` commitado é lido do disco e comparado ao documento gerado em runtime pelo `SwaggerModule` a partir da aplicação de teste.

#### 4.1. openapi-descreve-as-sete-rotas-da-fase

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. Carregar o `openapi.json` commitado e inspecionar `paths`
    - expect: as sete rotas da fase estão descritas — `POST /videos/uploads`, `GET /videos/uploads/{uploadId}/parts/{partNumber}`, `POST /videos/uploads/{uploadId}/complete`, `DELETE /videos/uploads/{uploadId}`, `GET /videos/{publicSlug}`, `GET /videos/{publicSlug}/playback`, `GET /videos/{publicSlug}/download`
    - expect: cada rota declara seus status de sucesso e de erro do `### Error Catalog`, e exige o security scheme bearer
  2. Comparar o `openapi.json` commitado com o documento gerado em runtime
    - expect: os dois são equivalentes — o spec commitado não está defasado em relação aos controllers
