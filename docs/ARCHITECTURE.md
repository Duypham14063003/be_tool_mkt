# Marketing Analytics Backend Architecture

## Runtime components

- **API (`src/main.ts`)**: REST, JWT authentication, validation, Swagger, rate limiting, audit context.
- **Worker (`src/worker.ts`)**: BullMQ consumers for social sync and report generation. HTTP requests never wait for providers or Playwright.
- **PostgreSQL**: users, encrypted platform credentials, posts, daily metrics, KPI definitions, jobs, reports, and audit records.
- **Redis/BullMQ**: asynchronous delivery, retries, exponential backoff, and per-account job serialization.
- **Provider boundary**: `SocialProvider` is implemented first by deterministic fake providers. Facebook/TikTok API adapters and Playwright collectors plug into the same normalized contracts later.

## Data and security decisions

- API metrics win during merge; Playwright only fills `null`/missing fields.
- Provider payloads and per-field provenance are retained in `rawData`.
- AES-256-GCM envelopes use `iv.authTag.ciphertext` (base64) and a 32-byte environment key.
- Refresh tokens are JWTs whose SHA-256 digest is stored on the user; logout/reissue invalidates the previous digest.
- Ownership is enforced in services. ADMIN may access all records; other roles only their own platform accounts and related data.
- A database `SyncJob` is the source of truth for frontend polling; BullMQ IDs use the same UUID.
- One active database job and BullMQ job ID per platform account prevents concurrent sync.
- Logs redact credentials, authorization, cookies, and browser state and carry a correlation ID.

## Modules

`auth`, `users`, `platform-accounts`, `facebook`, `tiktok`, `playwright`, `sync`, `jobs`, `posts`, `metrics`, `kpis`, `dashboard`, `reports`, `audit-logs`, `common`, `config`, `database`, and `health`.

## Directory layout

```text
src/
  main.ts                 API entrypoint
  worker.ts               worker entrypoint
  app.module.ts
  worker.module.ts
  auth/ users/ platform-accounts/
  facebook/ tiktok/ playwright/
  sync/ jobs/ posts/ metrics/
  kpis/ dashboard/ reports/ audit-logs/
  common/ config/ database/ health/
prisma/
  schema.prisma
  migrations/
  seed.ts
test/
docs/
reports/
```

## Delivery commits

1. `chore: bootstrap nest, docker, config and prisma`
2. `feat: add jwt auth, users and platform account ownership`
3. `feat: add bullmq sync worker and fake social providers`
4. `feat: add posts, metrics and dashboard queries`
5. `feat: add KPI calculations and CRUD`
6. `feat: add queued Excel report generation`
7. `feat: add audit, health, logging and API hardening`
8. `test: add unit and API integration coverage`
9. `docs: add operations and provider integration guide`

Facebook Graph, TikTok API, and Playwright collectors follow only after the fake-provider MVP is green.
