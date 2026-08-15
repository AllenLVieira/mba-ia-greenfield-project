---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-uploads.e2e-spec.ts
---

# Upload control plane — Test Plan

## Application Overview

As quatro rotas sob `/videos/uploads` publicam o handshake de upload multipart presignado, no formato que o cliente `@uppy/aws-s3` da futura fatia de frontend consome sem adaptador: `POST /videos/uploads` pré-cadastra o vídeo como rascunho em `PENDING_UPLOAD` e abre o multipart no bucket de ingest devolvendo `{ uploadId, key, publicSlug }`; `GET /videos/uploads/{uploadId}/parts/{partNumber}` presigna uma parte pelo cliente de endpoint **público** e move o vídeo para `UPLOADING` na primeira parte; `POST /videos/uploads/{uploadId}/complete` finaliza o objeto e enfileira o job `process-video`; `DELETE /videos/uploads/{uploadId}` aborta e libera as partes incompletas. Os bytes nunca transitam pela API — o browser faz `PUT` de cada parte direto no object storage. Todas as rotas rodam sob `JwtAuthGuard` mais o guard de propriedade, que delega a checagem a `VideosUploadService.assertOwnership()`; a matriz de autorização é owner-only e falha fechada, com `POST /videos/uploads` como a única rota sem vídeo pré-existente (qualquer autenticado com canal pode chamá-la, e o vídeo criado é vinculado ao canal do chamador). O UUID interno do vídeo nunca aparece nas respostas — o identificador público é o `publicSlug`.

## Test Scenarios

### 1. POST /videos/uploads

**Setup:** `beforeEach` trunca `videos`, `channels` e `users` via `dataSource.query('DELETE FROM ...')`; bootstrap do módulo de teste com `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo os globals de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`); seed de um usuário confirmado com canal e emissão do access token; MinIO alcançável pelo endpoint interno do Compose.

#### 1.1. initiate-abre-upload-e-retorna-handshake

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `POST /videos/uploads` com `Authorization: Bearer <token do dono>` e body `{ filename: "meu-video.mp4", sizeBytes: 1048576, contentType: "video/mp4" }`
    - expect: status `201`
    - expect: o corpo contém exatamente `uploadId` (string não vazia), `key` (string `videoId`-endereçada) e `publicSlug` (string de 11 caracteres base64url)
  2. Consultar o vídeo recém-criado no banco pelo `publicSlug` retornado
    - expect: `processingStatus` é `PENDING_UPLOAD`
    - expect: `title` é `"meu-video"` — o `filename` sem extensão
    - expect: `channelId` é o canal do chamador, e não um valor vindo do body
    - expect: `originalFilename`, `contentType` e `sizeBytes` refletem o que foi submetido, e `uploadId` está persistido

#### 1.2. initiate-rejeita-corpo-invalido

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `POST /videos/uploads` autenticado com body sem `filename`
    - expect: status `400` — o `ValidationPipe` está ativo na rota
  2. `POST /videos/uploads` autenticado com `sizeBytes` não inteiro positivo e `contentType` vazio
    - expect: status `400`
    - expect: nenhum vídeo foi pré-cadastrado no banco por nenhuma das chamadas rejeitadas

---

### 2. GET /videos/uploads/{uploadId}/parts/{partNumber}

**Setup:** o mesmo bootstrap do grupo 1, mais um upload aberto pelo dono via `POST /videos/uploads`, do qual o `uploadId` é reaproveitado.

#### 2.1. sign-part-rejeita-partnumber-menor-que-um

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `GET /videos/uploads/{uploadId}/parts/0` autenticado como dono
    - expect: status `400` — `@uppy/aws-s3` envia `partNumber` 1-based e nunca zero
  2. `GET /videos/uploads/{uploadId}/parts/-1` e `.../parts/abc` autenticado como dono
    - expect: status `400` em ambas
    - expect: o vídeo permanece em `PENDING_UPLOAD` — nenhuma chamada rejeitada dispara a transição para `UPLOADING`

#### 2.2. sign-part-presigna-e-move-para-uploading

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `GET /videos/uploads/{uploadId}/parts/1` autenticado como dono
    - expect: status `200` com `url` (string) e `headers` (objeto)
    - expect: a `url` aponta para o endpoint **público** do storage, não para o nome do serviço Compose
    - expect: o vídeo transita de `PENDING_UPLOAD` para `UPLOADING`
  2. `GET /videos/uploads/{uploadId}/parts/2` autenticado como dono
    - expect: status `200`
    - expect: o vídeo permanece em `UPLOADING` — assinar partes seguintes não altera o status

---

### 3. POST /videos/uploads/{uploadId}/complete

**Setup:** o mesmo bootstrap do grupo 1, mais um upload aberto pelo dono com ao menos uma parte assinada.

#### 3.1. complete-rejeita-parts-vazio

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `POST /videos/uploads/{uploadId}/complete` autenticado como dono com body `{ parts: [] }`
    - expect: status `400`
  2. `POST /videos/uploads/{uploadId}/complete` autenticado como dono com uma entrada faltando `ETag` e outra faltando `PartNumber`
    - expect: status `400`
    - expect: nenhum job `process-video` foi enfileirado por nenhuma das chamadas rejeitadas

#### 3.2. complete-com-uploadid-inexistente-retorna-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `POST /videos/uploads/{uploadId inexistente}/complete` autenticado, com `parts` válido
    - expect: status `404`
    - expect: o corpo carrega `error` igual a `"UPLOAD_NOT_FOUND"` no formato `{ statusCode, error, message }`

---

### 4. DELETE /videos/uploads/{uploadId}

**Setup:** o mesmo bootstrap do grupo 1, mais um upload aberto pelo dono.

#### 4.1. abort-retorna-204-e-invalida-uploadid

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. `DELETE /videos/uploads/{uploadId}` autenticado como dono de um upload aberto
    - expect: status `204` sem corpo
    - expect: o `uploadId` foi zerado no vídeo persistido
  2. `DELETE /videos/uploads/{uploadId}` de novo, com o mesmo `uploadId`
    - expect: status `404` com `error` igual a `"UPLOAD_NOT_FOUND"`
  3. `POST /videos/uploads/{uploadId}/complete` com o mesmo `uploadId` abortado
    - expect: status `404` com `error` igual a `"UPLOAD_NOT_FOUND"` — o `uploadId` é inexistente para toda chamada seguinte

---

### 5. Guards e exposição de identificadores no control plane

**Setup:** o mesmo bootstrap do grupo 1, mais um segundo usuário confirmado com canal próprio (o não-dono) e seu access token, e um upload aberto pelo primeiro usuário.

#### 5.1. control-plane-sem-authorization-retorna-401

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. Chamar as quatro rotas do control plane sem header `Authorization` — `POST /videos/uploads`, `GET /videos/uploads/{uploadId}/parts/1`, `POST /videos/uploads/{uploadId}/complete`, `DELETE /videos/uploads/{uploadId}`
    - expect: status `401` em todas as quatro
    - expect: o corpo de cada uma carrega `error` igual a `"INVALID_TOKEN"`
  2. Repetir as quatro chamadas com um token malformado ou expirado
    - expect: status `401` com `error` igual a `"INVALID_TOKEN"` em todas — a matriz falha fechada para anônimo

#### 5.2. control-plane-de-nao-dono-retorna-403

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. Chamar as três rotas endereçadas por `uploadId` — `GET /videos/uploads/{uploadId}/parts/1`, `POST /videos/uploads/{uploadId}/complete`, `DELETE /videos/uploads/{uploadId}` — autenticado como o segundo usuário, sobre o upload aberto pelo primeiro
    - expect: status `403` em todas as três
    - expect: o corpo de cada uma carrega `error` igual a `"VIDEO_ACCESS_DENIED"`
    - expect: o upload do dono permanece intacto — `uploadId` ainda presente e `processingStatus` inalterado
  2. `POST /videos/uploads` autenticado como o segundo usuário
    - expect: status `201` — é a única rota sem vídeo pré-existente, e o vídeo criado é vinculado ao canal do segundo usuário

#### 5.3. respostas-nao-expoem-uuid-interno

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-08-15T13:51:55Z

**Steps:**
  1. Percorrer o handshake completo como dono — `POST /videos/uploads`, `GET .../parts/1`, `POST .../complete` — e coletar os três corpos de resposta
    - expect: nenhum corpo contém um campo `id` com o UUID do vídeo
    - expect: o UUID do vídeo persistido não aparece em nenhum corpo, exceto embutido no `key` devolvido pelo `initiate` — artefato do protocolo de upload exigido por `@uppy/aws-s3`
    - expect: o identificador público devolvido e aceito pelas rotas seguintes é o `publicSlug` de 11 caracteres
