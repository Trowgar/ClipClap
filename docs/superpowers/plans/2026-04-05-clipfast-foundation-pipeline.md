# ClipFast Foundation + Backend Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete backend infrastructure and video processing pipeline so that a job can be created via API, processed through the full pipeline (download → transcribe → analyze → cut → subtitles), and clips stored in R2.

**Architecture:** Monorepo with npm workspaces. Three apps (web, worker, bot — bot deferred). Shared package for types, config, services, and lib clients. All services run in Docker Compose with PostgreSQL and Redis.

**Tech Stack:** Next.js 15, TypeScript, Prisma, PostgreSQL 16, BullMQ, Redis 7, OpenAI API (Whisper + GPT-4o-mini), FFmpeg, yt-dlp, Cloudflare R2, Auth.js v5, Docker

---

## Phase 1: Project Scaffolding

### Task 1: Root Monorepo Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Modify: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize root package.json with workspaces**

```json
{
  "name": "clipfast",
  "private": true,
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "dev": "docker compose up -d",
    "dev:down": "docker compose down",
    "db:push": "npx prisma db push",
    "db:generate": "npx prisma generate",
    "db:studio": "npx prisma studio",
    "lint": "npm run lint --workspaces --if-present",
    "test": "npm run test --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create base tsconfig**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": ".",
    "paths": {
      "@clipfast/shared": ["./packages/shared/src"],
      "@clipfast/shared/*": ["./packages/shared/src/*"]
    }
  }
}
```

- [ ] **Step 3: Update .gitignore**

```gitignore
# Dependencies
node_modules/

# Environment
.env
.env.local

# Build
dist/
.next/
out/

# Prisma
prisma/*.db

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Docker
pgdata/

# Temp files
tmp/
*.tmp
```

- [ ] **Step 4: Create .env.example**

```env
# Database
DATABASE_URL=postgresql://clipfast:clipfast_dev@postgres:5432/clipfast
POSTGRES_PASSWORD=clipfast_dev

# Redis
REDIS_URL=redis://redis:6379

# Auth
NEXTAUTH_SECRET=change-me-to-random-secret
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# OpenAI
OPENAI_API_KEY=
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_HIGHLIGHTS_MODEL=gpt-4o-mini

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=clipfast
R2_PUBLIC_URL=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_STARTER_PRICE_ID=
STRIPE_PRO_PRICE_ID=

# Telegram (post-MVP)
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_URL=
```

- [ ] **Step 5: Commit**

```bash
git init
git add package.json tsconfig.base.json .gitignore .env.example
git commit -m "feat: initialize monorepo with npm workspaces"
```

---

### Task 2: Prisma Schema

**Files:**
- Create: `prisma/schema.prisma`

- [ ] **Step 1: Write Prisma schema with all models**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Plan {
  FREE
  STARTER
  PRO
}

enum JobStatus {
  PENDING
  DOWNLOADING
  TRANSCRIBING
  ANALYZING
  CUTTING
  DONE
  FAILED
}

model User {
  id                    String   @id @default(cuid())
  email                 String?  @unique
  emailVerified         DateTime?
  telegramId            String?  @unique
  name                  String?
  avatarUrl             String?
  plan                  Plan     @default(FREE)
  stripeCustomerId      String?  @unique
  stripeSubscriptionId  String?  @unique
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  jobs    Job[]
  clips   Clip[]
  accounts Account[]
  sessions Session[]

  @@map("users")
}

model Job {
  id               String    @id @default(cuid())
  userId           String
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  sourceUrl        String?
  sourceKey        String?
  originalFilename String?
  status           JobStatus @default(PENDING)
  error            String?
  transcription    String?   @db.Text
  highlights       Json?
  subtitles        Boolean   @default(true)
  subtitlePreset   String?   @default("tiktok")
  createdAt        DateTime  @default(now())

  clips Clip[]

  @@index([userId])
  @@index([status])
  @@map("jobs")
}

model Clip {
  id             String  @id @default(cuid())
  jobId          String
  job            Job     @relation(fields: [jobId], references: [id], onDelete: Cascade)
  userId         String
  user           User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  title          String
  storageKey     String
  duration       Int
  startTime      Float
  endTime        Float
  subtitles      Boolean @default(true)
  subtitlePreset String?
  parentClipId   String?
  parentClip     Clip?   @relation("ClipRetrim", fields: [parentClipId], references: [id])
  retrims        Clip[]  @relation("ClipRetrim")
  createdAt      DateTime @default(now())

  @@index([jobId])
  @@index([userId])
  @@map("clips")
}

// Auth.js required models
model Account {
  id                String  @id @default(cuid())
  userId            String
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?

  @@unique([provider, providerAccountId])
  @@map("accounts")
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expires      DateTime

  @@map("sessions")
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime

  @@unique([identifier, token])
  @@map("verification_tokens")
}
```

- [ ] **Step 2: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add Prisma schema with User, Job, Clip models + Auth.js tables"
```

---

### Task 3: Shared Package — Types & Config

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/config/plans.ts`
- Create: `packages/shared/src/config/index.ts`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Create shared package.json**

```json
{
  "name": "@clipfast/shared",
  "version": "0.0.1",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@prisma/client": "^6.4.0",
    "bullmq": "^5.30.0",
    "ioredis": "^5.4.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0",
    "openai": "^4.80.0",
    "stripe": "^17.5.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "typescript": "^5.7.0",
    "prisma": "^6.4.0"
  }
}
```

- [ ] **Step 2: Create shared tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create types**

`packages/shared/src/types/index.ts`:

```typescript
import type { Job, Clip, User } from "@prisma/client";

export type { Job, Clip, User } from "@prisma/client";
export { Plan, JobStatus } from "@prisma/client";

export interface Highlight {
  start: number;
  end: number;
  title: string;
  reason: string;
}

export interface CreateJobInput {
  userId: string;
  sourceUrl?: string;
  sourceKey?: string;
  originalFilename?: string;
  subtitles?: boolean;
  subtitlePreset?: string;
}

export interface TrimClipInput {
  clipId: string;
  userId: string;
  start: number;
  end: number;
  subtitles: boolean;
  subtitlePreset?: string;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: WhisperSegment[];
}

export interface PipelineContext {
  jobId: string;
  userId: string;
  localVideoPath: string;
  transcription?: TranscriptionResult;
  highlights?: Highlight[];
  clipPaths?: string[];
}

export type SubtitlePreset = "tiktok" | "minimal" | "bold";
```

- [ ] **Step 4: Create plan config**

`packages/shared/src/config/plans.ts`:

```typescript
import { Plan } from "@prisma/client";

export interface PlanLimits {
  videosPerWeek: number;
  maxDurationMinutes: number;
  subtitlePresets: string[];
  telegramBot: boolean;
  watermark: boolean;
  priceWeekly: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    videosPerWeek: 2,
    maxDurationMinutes: 10,
    subtitlePresets: ["tiktok"],
    telegramBot: false,
    watermark: true,
    priceWeekly: 0,
  },
  STARTER: {
    videosPerWeek: 10,
    maxDurationMinutes: 60,
    subtitlePresets: ["tiktok", "minimal", "bold"],
    telegramBot: true,
    watermark: false,
    priceWeekly: 3,
  },
  PRO: {
    videosPerWeek: 30,
    maxDurationMinutes: 180,
    subtitlePresets: ["tiktok", "minimal", "bold"],
    telegramBot: true,
    watermark: false,
    priceWeekly: 5,
  },
};

export function getPlanLimits(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}
```

- [ ] **Step 5: Create config index**

`packages/shared/src/config/index.ts`:

```typescript
export { PLAN_LIMITS, getPlanLimits } from "./plans";
export type { PlanLimits } from "./plans";
```

- [ ] **Step 6: Create shared index**

`packages/shared/src/index.ts`:

```typescript
export * from "./types";
export * from "./config";
```

- [ ] **Step 7: Write test for plan config**

Create `packages/shared/src/config/__tests__/plans.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getPlanLimits, PLAN_LIMITS } from "../plans";

describe("Plan Limits", () => {
  it("FREE plan has watermark and 2 videos/week", () => {
    const limits = getPlanLimits("FREE");
    expect(limits.watermark).toBe(true);
    expect(limits.videosPerWeek).toBe(2);
    expect(limits.maxDurationMinutes).toBe(10);
  });

  it("STARTER plan has no watermark and 10 videos/week", () => {
    const limits = getPlanLimits("STARTER");
    expect(limits.watermark).toBe(false);
    expect(limits.videosPerWeek).toBe(10);
    expect(limits.subtitlePresets).toContain("bold");
  });

  it("PRO plan allows 30 videos/week and 3h max", () => {
    const limits = getPlanLimits("PRO");
    expect(limits.videosPerWeek).toBe(30);
    expect(limits.maxDurationMinutes).toBe(180);
  });

  it("all plans are defined", () => {
    expect(Object.keys(PLAN_LIMITS)).toEqual(["FREE", "STARTER", "PRO"]);
  });
});
```

- [ ] **Step 8: Run test**

```bash
cd packages/shared && npx vitest run
```

Expected: PASS — 4 tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/
git commit -m "feat: add shared package with types, plan config, and tests"
```

---

### Task 4: Shared Package — Lib Clients

**Files:**
- Create: `packages/shared/src/lib/prisma.ts`
- Create: `packages/shared/src/lib/redis.ts`
- Create: `packages/shared/src/lib/r2.ts`
- Create: `packages/shared/src/lib/queue.ts`
- Create: `packages/shared/src/lib/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create Prisma client singleton**

`packages/shared/src/lib/prisma.ts`:

```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query"] : [],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 2: Create Redis client**

`packages/shared/src/lib/redis.ts`:

```typescript
import IORedis from "ioredis";

let redis: IORedis | null = null;

export function getRedis(): IORedis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL environment variable is required");
    redis = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return redis;
}
```

- [ ] **Step 3: Create R2 client**

`packages/shared/src/lib/r2.ts`:

```typescript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "fs";
import { stat } from "fs/promises";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const accountId = process.env.R2_ACCOUNT_ID;
    if (!accountId) throw new Error("R2_ACCOUNT_ID is required");

    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return s3Client;
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is required");
  return bucket;
}

export async function uploadFile(
  key: string,
  filePath: string,
  contentType: string
): Promise<void> {
  const fileStats = await stat(filePath);
  const stream = createReadStream(filePath);

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: stream,
      ContentType: contentType,
      ContentLength: fileStats.size,
    })
  );
}

export async function downloadFile(key: string): Promise<ReadableStream> {
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    })
  );

  if (!response.Body) throw new Error(`File not found in R2: ${key}`);
  return response.Body.transformToWebStream();
}

export async function deleteFile(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    })
  );
}

export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  });

  return getSignedUrl(getS3Client(), command, {
    expiresIn: expiresInSeconds,
  });
}
```

- [ ] **Step 4: Create BullMQ queue helper**

`packages/shared/src/lib/queue.ts`:

```typescript
import { Queue } from "bullmq";
import { getRedis } from "./redis";

let videoQueue: Queue | null = null;

export const VIDEO_QUEUE_NAME = "video-processing";

export function getVideoQueue(): Queue {
  if (!videoQueue) {
    videoQueue = new Queue(VIDEO_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return videoQueue;
}
```

- [ ] **Step 5: Create lib index**

`packages/shared/src/lib/index.ts`:

```typescript
export { prisma } from "./prisma";
export { getRedis } from "./redis";
export { uploadFile, downloadFile, deleteFile, getPresignedDownloadUrl } from "./r2";
export { getVideoQueue, VIDEO_QUEUE_NAME } from "./queue";
```

- [ ] **Step 6: Update shared index to export lib**

`packages/shared/src/index.ts`:

```typescript
export * from "./types";
export * from "./config";
export * from "./lib";
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/lib/ packages/shared/src/index.ts
git commit -m "feat: add Prisma, Redis, R2, BullMQ client singletons"
```

---

### Task 5: Docker Compose + Dockerfiles

**Files:**
- Create: `docker-compose.yml`
- Create: `apps/web/Dockerfile`
- Create: `apps/worker/Dockerfile`

- [ ] **Step 1: Create docker-compose.yml**

```yaml
services:
  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      target: ${TARGET:-development}
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    volumes:
      - .:/app
      - /app/node_modules
      - /app/apps/web/node_modules
      - /app/apps/web/.next
    env_file: .env
    environment:
      - NODE_ENV=${NODE_ENV:-development}

  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
      target: ${TARGET:-development}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    volumes:
      - .:/app
      - /app/node_modules
      - /app/apps/worker/node_modules
    env_file: .env
    environment:
      - NODE_ENV=${NODE_ENV:-development}

  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: clipfast
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-clipfast_dev}
      POSTGRES_DB: clipfast
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U clipfast"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

- [ ] **Step 2: Create web Dockerfile**

`apps/web/Dockerfile`:

```dockerfile
# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

# --- Dependencies ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY prisma/ ./prisma/
RUN npm install
RUN npx prisma generate

# --- Development ---
FROM deps AS development
COPY . .
WORKDIR /app/apps/web
CMD ["npx", "next", "dev", "--hostname", "0.0.0.0"]

# --- Build ---
FROM deps AS build
COPY . .
WORKDIR /app/apps/web
RUN npx next build

# --- Production ---
FROM base AS production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
CMD ["node", "apps/web/server.js"]
```

- [ ] **Step 3: Create worker Dockerfile**

`apps/worker/Dockerfile`:

```dockerfile
# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache ffmpeg python3 py3-pip
RUN pip3 install --break-system-packages yt-dlp

# --- Dependencies ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
COPY prisma/ ./prisma/
RUN npm install
RUN npx prisma generate

# --- Development ---
FROM deps AS development
COPY . .
WORKDIR /app/apps/worker
CMD ["npx", "tsx", "watch", "src/index.ts"]

# --- Build ---
FROM deps AS build
COPY . .
WORKDIR /app/apps/worker
RUN npx tsc

# --- Production ---
FROM base AS production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/prisma ./prisma
RUN npx prisma generate
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml apps/web/Dockerfile apps/worker/Dockerfile
git commit -m "feat: add Docker Compose with web, worker, postgres, redis"
```

---

### Task 6: Next.js App Shell

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`

- [ ] **Step 1: Create web package.json**

```json
{
  "name": "@clipfast/web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^15.2.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "geist": "^1.3.0",
    "@clipfast/shared": "*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/postcss": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create next.config.ts**

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@clipfast/shared"],
};

export default nextConfig;
```

- [ ] **Step 3: Create tsconfig.json**

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowJs": true,
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./app/*", "./*"],
      "@clipfast/shared": ["../../packages/shared/src"],
      "@clipfast/shared/*": ["../../packages/shared/src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create postcss config**

`apps/web/postcss.config.mjs`:

```javascript
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 5: Create globals.css with Tailwind + dark theme**

`apps/web/app/globals.css`:

```css
@import "tailwindcss";

:root {
  --background: #000000;
  --foreground: #ededed;
  --muted: #888888;
  --border: #333333;
  --card: #111111;
  --accent: #ffffff;
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-geist-sans), system-ui, sans-serif;
}
```

- [ ] **Step 6: Create root layout with Geist font**

`apps/web/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipFast — AI Video Clipper",
  description: "Turn long videos into viral short clips with AI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: Create placeholder landing page**

`apps/web/app/page.tsx`:

```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center">
      <h1 className="text-4xl font-bold tracking-tight">ClipFast</h1>
      <p className="mt-2 text-[var(--muted)]">
        AI Video Clipper — Coming Soon
      </p>
    </main>
  );
}
```

- [ ] **Step 8: Verify build (after docker compose up)**

```bash
docker compose up -d web
docker compose logs web
# Expected: Next.js dev server running on http://localhost:3000
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/
git commit -m "feat: add Next.js 15 app shell with Geist font and dark theme"
```

---

### Task 7: Auth.js Setup

**Files:**
- Create: `apps/web/lib/auth.ts`
- Create: `apps/web/app/api/auth/[...nextauth]/route.ts`
- Create: `apps/web/app/(auth)/login/page.tsx`
- Create: `apps/web/middleware.ts`

- [ ] **Step 1: Install auth dependencies**

Add to `apps/web/package.json` dependencies:

```json
{
  "next-auth": "^5.0.0-beta.25",
  "@auth/prisma-adapter": "^2.7.0"
}
```

- [ ] **Step 2: Create auth config**

`apps/web/lib/auth.ts`:

```typescript
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@clipfast/shared";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
});
```

- [ ] **Step 3: Create auth API route**

`apps/web/app/api/auth/[...nextauth]/route.ts`:

```typescript
import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
```

- [ ] **Step 4: Create login page**

`apps/web/app/(auth)/login/page.tsx`:

```tsx
import { signIn } from "@/lib/auth";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">ClipFast</h1>
        <p className="mt-2 text-[var(--muted)]">Sign in to get started</p>
      </div>
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/dashboard" });
        }}
      >
        <button
          type="submit"
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-6 py-3 text-sm font-medium transition-colors hover:bg-[var(--border)]"
        >
          Continue with Google
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Create middleware for protected routes**

`apps/web/middleware.ts`:

```typescript
import { auth } from "@/lib/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isDashboard = req.nextUrl.pathname.startsWith("/dashboard");

  if (isDashboard && !isLoggedIn) {
    return Response.redirect(new URL("/login", req.nextUrl));
  }
});

export const config = {
  matcher: ["/dashboard/:path*"],
};
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/auth.ts apps/web/app/api/auth/ apps/web/app/(auth)/ apps/web/middleware.ts
git commit -m "feat: add Auth.js v5 with Google OAuth and route protection"
```

---

## Phase 2: Services + API

### Task 8: User Service

**Files:**
- Create: `packages/shared/src/services/user.service.ts`
- Create: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Create user service**

`packages/shared/src/services/user.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import type { User, Plan } from "@prisma/client";

export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export async function getUserByTelegramId(
  telegramId: string
): Promise<User | null> {
  return prisma.user.findUnique({ where: { telegramId } });
}

export async function getWeeklyUsage(userId: string): Promise<number> {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  return prisma.job.count({
    where: {
      userId,
      createdAt: { gte: oneWeekAgo },
      status: { not: "FAILED" },
    },
  });
}

export async function canCreateJob(userId: string): Promise<{
  allowed: boolean;
  reason?: string;
  usage: number;
  limit: number;
}> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const limits = getPlanLimits(user.plan);
  const usage = await getWeeklyUsage(userId);

  if (usage >= limits.videosPerWeek) {
    return {
      allowed: false,
      reason: `Weekly limit reached (${usage}/${limits.videosPerWeek}). Upgrade your plan for more.`,
      usage,
      limit: limits.videosPerWeek,
    };
  }

  return { allowed: true, usage, limit: limits.videosPerWeek };
}

export async function getUsage(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const limits = getPlanLimits(user.plan);
  const weeklyUsage = await getWeeklyUsage(userId);

  return {
    plan: user.plan,
    videosUsed: weeklyUsage,
    videosLimit: limits.videosPerWeek,
    maxDurationMinutes: limits.maxDurationMinutes,
  };
}
```

- [ ] **Step 2: Create services index**

`packages/shared/src/services/index.ts`:

```typescript
export * as userService from "./user.service";
```

- [ ] **Step 3: Export services from shared**

Update `packages/shared/src/index.ts`:

```typescript
export * from "./types";
export * from "./config";
export * from "./lib";
export * from "./services";
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/services/ packages/shared/src/index.ts
git commit -m "feat: add user service with plan limit checking and usage tracking"
```

---

### Task 9: Job Service

**Files:**
- Create: `packages/shared/src/services/job.service.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Create job service**

`packages/shared/src/services/job.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { getVideoQueue } from "../lib/queue";
import type { Job, JobStatus } from "@prisma/client";
import type { CreateJobInput } from "../types";

export async function createJob(input: CreateJobInput): Promise<Job> {
  const job = await prisma.job.create({
    data: {
      userId: input.userId,
      sourceUrl: input.sourceUrl,
      sourceKey: input.sourceKey,
      originalFilename: input.originalFilename,
      subtitles: input.subtitles ?? true,
      subtitlePreset: input.subtitlePreset ?? "tiktok",
      status: "PENDING",
    },
  });

  await getVideoQueue().add("process-video", {
    jobId: job.id,
    userId: job.userId,
  });

  return job;
}

export async function getJob(
  jobId: string,
  userId: string
): Promise<Job | null> {
  return prisma.job.findFirst({
    where: { id: jobId, userId },
    include: { clips: true },
  });
}

export async function getUserJobs(userId: string): Promise<Job[]> {
  return prisma.job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { clips: true },
    take: 50,
  });
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: { error?: string; transcription?: string; highlights?: unknown }
): Promise<Job> {
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status,
      ...(extra?.error && { error: extra.error }),
      ...(extra?.transcription && { transcription: extra.transcription }),
      ...(extra?.highlights && {
        highlights: extra.highlights as Record<string, unknown>,
      }),
    },
  });
}
```

- [ ] **Step 2: Update services index**

`packages/shared/src/services/index.ts`:

```typescript
export * as userService from "./user.service";
export * as jobService from "./job.service";
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/services/
git commit -m "feat: add job service with create, get, list, and status update"
```

---

### Task 10: Clip Service

**Files:**
- Create: `packages/shared/src/services/clip.service.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Create clip service**

`packages/shared/src/services/clip.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { getPresignedDownloadUrl, deleteFile } from "../lib/r2";
import { getVideoQueue } from "../lib/queue";
import type { Clip } from "@prisma/client";
import type { TrimClipInput } from "../types";

export async function getClipsByJob(
  jobId: string,
  userId: string
): Promise<Clip[]> {
  return prisma.clip.findMany({
    where: { jobId, userId },
    orderBy: { startTime: "asc" },
  });
}

export async function getUserClips(userId: string): Promise<Clip[]> {
  return prisma.clip.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function getClip(
  clipId: string,
  userId: string
): Promise<Clip | null> {
  return prisma.clip.findFirst({
    where: { id: clipId, userId },
  });
}

export async function getDownloadUrl(
  clipId: string,
  userId: string
): Promise<string> {
  const clip = await prisma.clip.findFirstOrThrow({
    where: { id: clipId, userId },
  });
  return getPresignedDownloadUrl(clip.storageKey);
}

export async function deleteClip(
  clipId: string,
  userId: string
): Promise<void> {
  const clip = await prisma.clip.findFirstOrThrow({
    where: { id: clipId, userId },
  });

  await deleteFile(clip.storageKey);
  await prisma.clip.delete({ where: { id: clipId } });
}

export async function trimClip(input: TrimClipInput): Promise<Clip> {
  const original = await prisma.clip.findFirstOrThrow({
    where: { id: input.clipId, userId: input.userId },
    include: { job: true },
  });

  // Create a new clip record as a placeholder
  const newClip = await prisma.clip.create({
    data: {
      jobId: original.jobId,
      userId: input.userId,
      title: `${original.title} (trimmed)`,
      storageKey: "", // will be set by worker
      duration: Math.round(input.end - input.start),
      startTime: input.start,
      endTime: input.end,
      subtitles: input.subtitles,
      subtitlePreset: input.subtitlePreset,
      parentClipId: original.id,
    },
  });

  // Enqueue a trim job
  await getVideoQueue().add("trim-clip", {
    clipId: newClip.id,
    originalClipStorageKey: original.storageKey,
    jobId: original.jobId,
    userId: input.userId,
    start: input.start,
    end: input.end,
    subtitles: input.subtitles,
    subtitlePreset: input.subtitlePreset,
  });

  return newClip;
}
```

- [ ] **Step 2: Update services index**

`packages/shared/src/services/index.ts`:

```typescript
export * as userService from "./user.service";
export * as jobService from "./job.service";
export * as clipService from "./clip.service";
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/services/
git commit -m "feat: add clip service with CRUD, download URL, and trim support"
```

---

### Task 11: Job API Routes

**Files:**
- Create: `apps/web/app/api/jobs/route.ts`
- Create: `apps/web/app/api/jobs/[id]/route.ts`
- Create: `apps/web/app/api/jobs/[id]/stream/route.ts`

- [ ] **Step 1: Create POST + GET /api/jobs**

`apps/web/app/api/jobs/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { jobService, userService, uploadFile } from "@clipfast/shared";
import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  // Check plan limits
  const check = await userService.canCreateJob(userId);
  if (!check.allowed) {
    return NextResponse.json(
      { error: check.reason, usage: check.usage, limit: check.limit },
      { status: 429 }
    );
  }

  const formData = await req.formData();
  const url = formData.get("url") as string | null;
  const file = formData.get("file") as File | null;
  const subtitles = formData.get("subtitles") !== "false";
  const subtitlePreset =
    (formData.get("subtitlePreset") as string) || "tiktok";

  if (!url && !file) {
    return NextResponse.json(
      { error: "Provide a video file or URL" },
      { status: 400 }
    );
  }

  let sourceKey: string | undefined;
  let originalFilename: string | undefined;

  if (file) {
    // Save file to temp, upload to R2
    const ext = file.name.split(".").pop() || "mp4";
    sourceKey = `uploads/${userId}/${randomUUID()}.${ext}`;
    originalFilename = file.name;

    const tmpPath = join(tmpdir(), `${randomUUID()}.${ext}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await writeFile(tmpPath, bytes);
    await uploadFile(sourceKey, tmpPath, file.type || "video/mp4");
  }

  const job = await jobService.createJob({
    userId,
    sourceUrl: url || undefined,
    sourceKey,
    originalFilename,
    subtitles,
    subtitlePreset,
  });

  return NextResponse.json(job, { status: 201 });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobs = await jobService.getUserJobs(session.user.id);
  return NextResponse.json(jobs);
}
```

- [ ] **Step 2: Create GET /api/jobs/[id]**

`apps/web/app/api/jobs/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { jobService } from "@clipfast/shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const job = await jobService.getJob(id, session.user.id);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json(job);
}
```

- [ ] **Step 3: Create SSE stream for job progress**

`apps/web/app/api/jobs/[id]/stream/route.ts`:

```typescript
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@clipfast/shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      // Poll job status every 2 seconds
      const interval = setInterval(async () => {
        try {
          const job = await prisma.job.findFirst({
            where: { id, userId },
            include: { clips: true },
          });

          if (!job) {
            send({ error: "Job not found" });
            clearInterval(interval);
            controller.close();
            return;
          }

          send({
            status: job.status,
            error: job.error,
            clipCount: job.clips.length,
          });

          if (job.status === "DONE" || job.status === "FAILED") {
            clearInterval(interval);
            controller.close();
          }
        } catch {
          clearInterval(interval);
          controller.close();
        }
      }, 2000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/jobs/
git commit -m "feat: add job API routes — create, list, get, SSE progress"
```

---

### Task 12: Clip API Routes

**Files:**
- Create: `apps/web/app/api/clips/route.ts`
- Create: `apps/web/app/api/clips/[id]/route.ts`
- Create: `apps/web/app/api/clips/[id]/download/route.ts`
- Create: `apps/web/app/api/clips/[id]/trim/route.ts`

- [ ] **Step 1: Create GET /api/clips**

`apps/web/app/api/clips/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipfast/shared";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clips = await clipService.getUserClips(session.user.id);
  return NextResponse.json(clips);
}
```

- [ ] **Step 2: Create GET + DELETE /api/clips/[id]**

`apps/web/app/api/clips/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipfast/shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const clip = await clipService.getClip(id, session.user.id);

  if (!clip) {
    return NextResponse.json({ error: "Clip not found" }, { status: 404 });
  }

  return NextResponse.json(clip);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  await clipService.deleteClip(id, session.user.id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create GET /api/clips/[id]/download**

`apps/web/app/api/clips/[id]/download/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipfast/shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const url = await clipService.getDownloadUrl(id, session.user.id);
  return NextResponse.json({ url });
}
```

- [ ] **Step 4: Create POST /api/clips/[id]/trim**

`apps/web/app/api/clips/[id]/trim/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipfast/shared";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();

  if (typeof body.start !== "number" || typeof body.end !== "number") {
    return NextResponse.json(
      { error: "start and end are required numbers" },
      { status: 400 }
    );
  }

  if (body.end <= body.start) {
    return NextResponse.json(
      { error: "end must be greater than start" },
      { status: 400 }
    );
  }

  const clip = await clipService.trimClip({
    clipId: id,
    userId: session.user.id,
    start: body.start,
    end: body.end,
    subtitles: body.subtitles ?? true,
    subtitlePreset: body.subtitlePreset,
  });

  return NextResponse.json(clip, { status: 201 });
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/clips/
git commit -m "feat: add clip API routes — list, get, download, delete, trim"
```

---

## Phase 3: Video Processing Worker

### Task 13: Worker Setup + Entry Point

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/index.ts`

- [ ] **Step 1: Create worker package.json**

```json
{
  "name": "@clipfast/worker",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@clipfast/shared": "*",
    "bullmq": "^5.30.0",
    "openai": "^4.80.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create worker tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create worker entry point**

`apps/worker/src/index.ts`:

```typescript
import { Worker } from "bullmq";
import { getRedis, VIDEO_QUEUE_NAME } from "@clipfast/shared";
import { processVideoJob } from "./pipeline";

console.log("ClipFast Worker starting...");

const worker = new Worker(
  VIDEO_QUEUE_NAME,
  async (job) => {
    console.log(`Processing job: ${job.id} (${job.name})`);

    if (job.name === "process-video") {
      await processVideoJob(job.data.jobId, job.data.userId);
    }

    // trim-clip handled in Phase 2 plan (frontend + billing)
  },
  {
    connection: getRedis(),
    concurrency: 2,
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});

console.log(`Worker listening on queue: ${VIDEO_QUEUE_NAME}`);
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/
git commit -m "feat: add worker entry point with BullMQ consumer"
```

---

### Task 14: Download Processor

**Files:**
- Create: `apps/worker/src/processors/download.ts`

- [ ] **Step 1: Create download processor**

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { downloadFile } from "@clipfast/shared";
import type { Readable } from "stream";

const execFileAsync = promisify(execFile);

export async function downloadVideo(
  sourceUrl?: string,
  sourceKey?: string
): Promise<string> {
  const outputPath = join(tmpdir(), `clipfast-${randomUUID()}.mp4`);

  if (sourceUrl) {
    return downloadFromUrl(sourceUrl, outputPath);
  }

  if (sourceKey) {
    return downloadFromR2(sourceKey, outputPath);
  }

  throw new Error("No source URL or storage key provided");
}

async function downloadFromUrl(
  url: string,
  outputPath: string
): Promise<string> {
  const { stdout } = await execFileAsync("yt-dlp", [
    url,
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "--merge-output-format",
    "mp4",
    "-o",
    outputPath,
    "--no-playlist",
    "--max-filesize",
    "2G",
  ]);

  console.log("yt-dlp output:", stdout);
  return outputPath;
}

async function downloadFromR2(
  key: string,
  outputPath: string
): Promise<string> {
  const webStream = await downloadFile(key);
  const nodeStream = webStream as unknown as Readable;
  const writeStream = createWriteStream(outputPath);
  await pipeline(nodeStream, writeStream);
  return outputPath;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/processors/download.ts
git commit -m "feat: add download processor — yt-dlp for URLs, R2 for uploads"
```

---

### Task 15: Transcribe Processor

**Files:**
- Create: `apps/worker/src/processors/transcribe.ts`

- [ ] **Step 1: Create transcribe processor**

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { unlink } from "fs/promises";
import OpenAI from "openai";
import type { TranscriptionResult, WhisperSegment } from "@clipfast/shared";

const execFileAsync = promisify(execFile);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeVideo(
  videoPath: string
): Promise<TranscriptionResult> {
  // Extract audio with ffmpeg
  const audioPath = join(tmpdir(), `clipfast-audio-${randomUUID()}.wav`);

  await execFileAsync("ffmpeg", [
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    audioPath,
    "-y",
  ]);

  try {
    // Send to Whisper API with verbose_json for segments
    const response = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });

    const segments: WhisperSegment[] = (
      (response as Record<string, unknown>).segments as Array<{
        start: number;
        end: number;
        text: string;
      }>
    ).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));

    return {
      text: response.text,
      segments,
    };
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/processors/transcribe.ts
git commit -m "feat: add transcribe processor — ffmpeg audio extraction + Whisper API"
```

---

### Task 16: Analyze Processor

**Files:**
- Create: `apps/worker/src/processors/analyze.ts`

- [ ] **Step 1: Create analyze processor**

```typescript
import OpenAI from "openai";
import type { Highlight, TranscriptionResult } from "@clipfast/shared";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a video content analyst. Given a transcript with timestamps, identify the most engaging, funny, insightful, or viral-worthy moments for short-form content (TikTok, Reels, Shorts).

Rules:
- Find 3-5 best moments
- Each clip should be 30-90 seconds long
- Prefer moments with strong hooks (questions, surprises, emotional peaks)
- Avoid mid-sentence cuts — start and end at natural breaks
- Return ONLY valid JSON, no markdown

Output format:
[
  {
    "start": 12.5,
    "end": 55.2,
    "title": "Short catchy title for the clip",
    "reason": "Why this moment is engaging"
  }
]`;

export async function analyzeHighlights(
  transcription: TranscriptionResult
): Promise<Highlight[]> {
  // Format transcript with timestamps for the LLM
  const formattedTranscript = transcription.segments
    .map((s) => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_HIGHLIGHTS_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze this transcript and find the best moments:\n\n${formattedTranscript}`,
      },
    ],
    temperature: 0.7,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from LLM");

  const parsed = JSON.parse(content);

  // Handle both {highlights: [...]} and [...] formats
  const highlights: Highlight[] = Array.isArray(parsed)
    ? parsed
    : parsed.highlights || parsed.moments || parsed.clips || [];

  if (highlights.length === 0) {
    throw new Error("No highlights found in the video");
  }

  // Validate and clean
  return highlights.map((h) => ({
    start: Number(h.start),
    end: Number(h.end),
    title: String(h.title),
    reason: String(h.reason),
  }));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/processors/analyze.ts
git commit -m "feat: add analyze processor — GPT-4o-mini highlight extraction"
```

---

### Task 17: Cut Processor

**Files:**
- Create: `apps/worker/src/processors/cut.ts`

- [ ] **Step 1: Create cut processor**

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Highlight } from "@clipfast/shared";

const execFileAsync = promisify(execFile);

export interface CutResult {
  highlight: Highlight;
  clipPath: string;
}

export async function cutClips(
  videoPath: string,
  highlights: Highlight[]
): Promise<CutResult[]> {
  const results: CutResult[] = [];

  for (const highlight of highlights) {
    const clipPath = join(tmpdir(), `clipfast-clip-${randomUUID()}.mp4`);

    await execFileAsync("ffmpeg", [
      "-ss",
      String(highlight.start),
      "-to",
      String(highlight.end),
      "-i",
      videoPath,
      "-vf",
      buildCropFilter(),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      clipPath,
      "-y",
    ]);

    results.push({ highlight, clipPath });
  }

  return results;
}

/**
 * Builds an FFmpeg filter to crop video to 9:16 vertical format.
 * Centers the crop on the original video.
 */
function buildCropFilter(): string {
  // crop to 9:16 from center of original video
  // if source is 16:9 (1920x1080) → crop to 607x1080 center
  return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920";
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/processors/cut.ts
git commit -m "feat: add cut processor — FFmpeg vertical crop and clip extraction"
```

---

### Task 18: Subtitles Processor

**Files:**
- Create: `apps/worker/src/processors/subtitles.ts`
- Create: `apps/worker/src/processors/__tests__/subtitles.test.ts`

- [ ] **Step 1: Create subtitle presets and ASS generator**

`apps/worker/src/processors/subtitles.ts`:

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { WhisperSegment, SubtitlePreset } from "@clipfast/shared";

const execFileAsync = promisify(execFile);

interface SubtitleStyle {
  fontName: string;
  fontSize: number;
  primaryColor: string; // ASS color format: &HAABBGGRR
  outlineColor: string;
  backColor: string;
  bold: boolean;
  outline: number;
  shadow: number;
  marginV: number;
}

const PRESETS: Record<SubtitlePreset, SubtitleStyle> = {
  tiktok: {
    fontName: "Arial",
    fontSize: 18,
    primaryColor: "&H00FFFFFF", // white
    outlineColor: "&H00000000", // black
    backColor: "&H80000000",
    bold: true,
    outline: 3,
    shadow: 0,
    marginV: 60,
  },
  minimal: {
    fontName: "Arial",
    fontSize: 14,
    primaryColor: "&H00FFFFFF",
    outlineColor: "&H00000000",
    backColor: "&H00000000",
    bold: false,
    outline: 1,
    shadow: 1,
    marginV: 40,
  },
  bold: {
    fontName: "Impact",
    fontSize: 22,
    primaryColor: "&H0000FFFF", // yellow
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    bold: true,
    outline: 4,
    shadow: 0,
    marginV: 80,
  },
};

export function generateAss(
  segments: WhisperSegment[],
  clipStart: number,
  clipEnd: number,
  preset: SubtitlePreset = "tiktok"
): string {
  const style = PRESETS[preset];
  const boldFlag = style.bold ? -1 : 0;

  const header = `[Script Info]
Title: ClipFast Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${style.fontSize},${style.primaryColor},&H000000FF,${style.outlineColor},${style.backColor},${boldFlag},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,20,20,${style.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  // Filter and adjust segments to clip timeframe
  const events = segments
    .filter((s) => s.end > clipStart && s.start < clipEnd)
    .map((s) => {
      const start = Math.max(0, s.start - clipStart);
      const end = Math.min(clipEnd - clipStart, s.end - clipStart);
      const text = s.text.replace(/\n/g, "\\N");
      return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}

function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export async function burnSubtitles(
  videoPath: string,
  segments: WhisperSegment[],
  clipStart: number,
  clipEnd: number,
  preset: SubtitlePreset = "tiktok"
): Promise<string> {
  const assContent = generateAss(segments, clipStart, clipEnd, preset);
  const assPath = join(tmpdir(), `clipfast-subs-${randomUUID()}.ass`);
  const outputPath = join(tmpdir(), `clipfast-subbed-${randomUUID()}.mp4`);

  await writeFile(assPath, assContent, "utf-8");

  try {
    // Escape colons and backslashes in path for FFmpeg filter
    const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

    await execFileAsync("ffmpeg", [
      "-i",
      videoPath,
      "-vf",
      `ass=${escapedAssPath}`,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
      "-y",
    ]);

    return outputPath;
  } finally {
    await unlink(assPath).catch(() => {});
  }
}
```

- [ ] **Step 2: Write test for ASS generation**

`apps/worker/src/processors/__tests__/subtitles.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateAss } from "../subtitles";
import type { WhisperSegment } from "@clipfast/shared";

const segments: WhisperSegment[] = [
  { start: 10.0, end: 13.5, text: "Hello everyone" },
  { start: 13.5, end: 18.0, text: "Welcome to the stream" },
  { start: 18.0, end: 25.0, text: "Today we are going to talk about AI" },
  { start: 50.0, end: 55.0, text: "This is outside the clip range" },
];

describe("generateAss", () => {
  it("generates valid ASS with tiktok preset", () => {
    const ass = generateAss(segments, 10.0, 25.0, "tiktok");

    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Style: Default,Arial,18");
    expect(ass).toContain("Bold,-1");
  });

  it("adjusts segment times relative to clip start", () => {
    const ass = generateAss(segments, 10.0, 25.0, "tiktok");

    // "Hello everyone" starts at 10.0 in source, clip starts at 10.0
    // so relative start = 0.0
    expect(ass).toContain("0:00:00.00,0:00:03.50");
    // "Welcome to the stream" starts at 13.5 - 10.0 = 3.5
    expect(ass).toContain("0:00:03.50,0:00:08.00");
  });

  it("filters out segments outside clip range", () => {
    const ass = generateAss(segments, 10.0, 25.0, "tiktok");

    expect(ass).not.toContain("outside the clip range");
  });

  it("applies bold preset style", () => {
    const ass = generateAss(segments, 10.0, 25.0, "bold");

    expect(ass).toContain("Impact");
    expect(ass).toContain("&H0000FFFF"); // yellow
  });

  it("applies minimal preset style", () => {
    const ass = generateAss(segments, 10.0, 25.0, "minimal");

    expect(ass).toContain("Bold,0"); // not bold
    expect(ass).toContain(",14,"); // smaller font
  });
});
```

- [ ] **Step 3: Run test**

```bash
cd apps/worker && npx vitest run src/processors/__tests__/subtitles.test.ts
```

Expected: PASS — 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/
git commit -m "feat: add subtitles processor — ASS generation with 3 presets + FFmpeg burn-in"
```

---

### Task 19: Pipeline Orchestrator

**Files:**
- Create: `apps/worker/src/pipeline.ts`

- [ ] **Step 1: Create pipeline orchestrator**

```typescript
import { jobService, uploadFile, prisma, getPlanLimits } from "@clipfast/shared";
import type { TranscriptionResult, Highlight } from "@clipfast/shared";
import { downloadVideo } from "./processors/download";
import { transcribeVideo } from "./processors/transcribe";
import { analyzeHighlights } from "./processors/analyze";
import { cutClips } from "./processors/cut";
import { burnSubtitles } from "./processors/subtitles";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";

export async function processVideoJob(
  jobId: string,
  userId: string
): Promise<void> {
  const tempFiles: string[] = [];

  const cleanup = async () => {
    for (const f of tempFiles) {
      await unlink(f).catch(() => {});
    }
  };

  try {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const planLimits = getPlanLimits(user.plan);

    // Step 1: Download
    await jobService.updateJobStatus(jobId, "DOWNLOADING");
    const videoPath = await downloadVideo(
      job.sourceUrl ?? undefined,
      job.sourceKey ?? undefined
    );
    tempFiles.push(videoPath);
    console.log(`[${jobId}] Downloaded to ${videoPath}`);

    // Step 2: Transcribe
    await jobService.updateJobStatus(jobId, "TRANSCRIBING");
    const transcription: TranscriptionResult =
      await transcribeVideo(videoPath);
    await jobService.updateJobStatus(jobId, "TRANSCRIBING", {
      transcription: transcription.text,
    });
    console.log(
      `[${jobId}] Transcribed: ${transcription.segments.length} segments`
    );

    // Step 3: Analyze
    await jobService.updateJobStatus(jobId, "ANALYZING");
    const highlights: Highlight[] =
      await analyzeHighlights(transcription);
    await jobService.updateJobStatus(jobId, "ANALYZING", {
      highlights,
    });
    console.log(`[${jobId}] Found ${highlights.length} highlights`);

    // Step 4: Cut + Subtitles + Upload
    await jobService.updateJobStatus(jobId, "CUTTING");

    for (const highlight of highlights) {
      // Cut the clip
      const [cutResult] = await cutClips(videoPath, [highlight]);
      tempFiles.push(cutResult.clipPath);

      let finalClipPath = cutResult.clipPath;

      // Add subtitles if enabled
      if (job.subtitles) {
        const preset = (job.subtitlePreset as "tiktok" | "minimal" | "bold") || "tiktok";
        const subbedPath = await burnSubtitles(
          cutResult.clipPath,
          transcription.segments,
          highlight.start,
          highlight.end,
          preset
        );
        tempFiles.push(subbedPath);
        finalClipPath = subbedPath;
      }

      // TODO: Add watermark for FREE plan (post-MVP polish)

      // Upload to R2
      const storageKey = `clips/${userId}/${jobId}/${randomUUID()}.mp4`;
      await uploadFile(storageKey, finalClipPath, "video/mp4");

      // Create clip record
      await prisma.clip.create({
        data: {
          jobId,
          userId,
          title: highlight.title,
          storageKey,
          duration: Math.round(highlight.end - highlight.start),
          startTime: highlight.start,
          endTime: highlight.end,
          subtitles: job.subtitles,
          subtitlePreset: job.subtitlePreset,
        },
      });

      console.log(`[${jobId}] Clip uploaded: ${highlight.title}`);
    }

    // Done
    await jobService.updateJobStatus(jobId, "DONE");
    console.log(`[${jobId}] Job complete — ${highlights.length} clips`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[${jobId}] Pipeline failed:`, message);
    await jobService.updateJobStatus(jobId, "FAILED", { error: message });
    throw error;
  } finally {
    await cleanup();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/pipeline.ts
git commit -m "feat: add pipeline orchestrator — full video processing flow with cleanup"
```

---

## Phase 4: Billing API

### Task 20: Billing Service

**Files:**
- Create: `packages/shared/src/services/billing.service.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Create billing service**

`packages/shared/src/services/billing.service.ts`:

```typescript
import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import type { Plan } from "@prisma/client";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is required");
  return new Stripe(key);
}

const PLAN_TO_PRICE_ID: Record<string, Plan> = {};

function getPriceIdToPlan(): Record<string, Plan> {
  return {
    [process.env.STRIPE_STARTER_PRICE_ID || ""]: "STARTER",
    [process.env.STRIPE_PRO_PRICE_ID || ""]: "PRO",
  };
}

export async function createCheckoutSession(
  userId: string,
  plan: "STARTER" | "PRO",
  successUrl: string,
  cancelUrl: string
): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const stripe = getStripe();

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { userId },
    });
    customerId = customer.id;
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customerId },
    });
  }

  const priceId =
    plan === "STARTER"
      ? process.env.STRIPE_STARTER_PRICE_ID
      : process.env.STRIPE_PRO_PRICE_ID;

  if (!priceId) throw new Error(`Price ID not configured for plan: ${plan}`);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId },
  });

  return session.url!;
}

export async function handleWebhook(
  body: string,
  signature: string
): Promise<void> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (!userId) break;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

      // Get the plan from the subscription's price
      if (subscriptionId) {
        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price?.id;
        const priceMap = getPriceIdToPlan();
        const plan = priceId ? priceMap[priceId] : undefined;

        if (plan) {
          await prisma.user.update({
            where: { id: userId },
            data: {
              plan,
              stripeSubscriptionId: subscriptionId,
            },
          });
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data
        .object as Stripe.Subscription;
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: { plan: "FREE", stripeSubscriptionId: null },
      });
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data
        .object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const priceMap = getPriceIdToPlan();
      const plan = priceId ? priceMap[priceId] : undefined;

      if (plan) {
        await prisma.user.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { plan },
        });
      }
      break;
    }
  }
}

export async function getSubscription(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!user.stripeSubscriptionId) {
    return { plan: user.plan, subscription: null };
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(
    user.stripeSubscriptionId
  );

  return {
    plan: user.plan,
    subscription: {
      status: subscription.status,
      currentPeriodEnd: new Date(
        subscription.current_period_end * 1000
      ).toISOString(),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
  };
}
```

- [ ] **Step 2: Update services index**

`packages/shared/src/services/index.ts`:

```typescript
export * as userService from "./user.service";
export * as jobService from "./job.service";
export * as clipService from "./clip.service";
export * as billingService from "./billing.service";
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/services/
git commit -m "feat: add billing service — Stripe checkout, webhooks, subscription management"
```

---

### Task 21: Billing API Routes

**Files:**
- Create: `apps/web/app/api/billing/checkout/route.ts`
- Create: `apps/web/app/api/billing/webhook/route.ts`
- Create: `apps/web/app/api/billing/subscription/route.ts`

- [ ] **Step 1: Create POST /api/billing/checkout**

`apps/web/app/api/billing/checkout/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { billingService } from "@clipfast/shared";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const plan = body.plan as "STARTER" | "PRO";

  if (!["STARTER", "PRO"].includes(plan)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const url = await billingService.createCheckoutSession(
    session.user.id,
    plan,
    `${origin}/dashboard?checkout=success`,
    `${origin}/dashboard/plans?checkout=cancelled`
  );

  return NextResponse.json({ url });
}
```

- [ ] **Step 2: Create POST /api/billing/webhook**

`apps/web/app/api/billing/webhook/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { billingService } from "@clipfast/shared";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature" },
      { status: 400 }
    );
  }

  try {
    await billingService.handleWebhook(body, signature);
    return NextResponse.json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    console.error("Stripe webhook error:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 3: Create GET /api/billing/subscription**

`apps/web/app/api/billing/subscription/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { billingService, userService } from "@clipfast/shared";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [subscription, usage] = await Promise.all([
    billingService.getSubscription(session.user.id),
    userService.getUsage(session.user.id),
  ]);

  return NextResponse.json({ ...subscription, usage });
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/billing/
git commit -m "feat: add billing API routes — checkout, webhook, subscription status"
```

---

## Phase 5: Integration Verification

### Task 22: .env Setup + Docker Smoke Test

**Files:**
- Verify: `.env.example` (already created)
- Verify: `docker-compose.yml` (already created)

- [ ] **Step 1: Copy .env.example to .env and fill in values**

```bash
cp .env.example .env
# Edit .env with actual API keys
```

- [ ] **Step 2: Install all dependencies**

```bash
npm install
```

- [ ] **Step 3: Start Docker Compose**

```bash
docker compose up -d
```

Expected: All services start — web on :3000, postgres on :5432, redis on :6379, worker running.

- [ ] **Step 4: Run Prisma migration**

```bash
npx prisma db push
```

Expected: Database schema created in PostgreSQL.

- [ ] **Step 5: Verify web app loads**

Open `http://localhost:3000` — should see "ClipFast — AI Video Clipper — Coming Soon".

- [ ] **Step 6: Verify worker is running**

```bash
docker compose logs worker
```

Expected: "ClipFast Worker starting..." and "Worker listening on queue: video-processing".

- [ ] **Step 7: Commit any adjustments**

```bash
git add -A
git commit -m "chore: verify full Docker stack boots correctly"
```

---

### Task 23: CLAUDE.md Project Guide

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Create CLAUDE.md**

```markdown
# ClipFast — AI Video Clipper

## Project Overview

ClipFast turns long videos into short, subtitle-enhanced clips for TikTok/Reels/Shorts.
Users upload a video or paste a URL → AI transcribes, finds highlights, cuts clips, adds subtitles.

## Architecture

Monorepo with npm workspaces. Three Docker services + Postgres + Redis.

```
apps/web/        → Next.js 15 (App Router) — frontend + API routes
apps/worker/     → BullMQ worker — video processing pipeline
apps/bot/        → grammY Telegram bot (post-MVP)
packages/shared/ → Types, config, services, lib clients (Prisma, Redis, R2, Queue)
prisma/          → Database schema
```

## Quick Start

```bash
cp .env.example .env   # fill in API keys
docker compose up -d   # starts web, worker, postgres, redis
npx prisma db push     # create DB tables
# Open http://localhost:3000
```

## Tech Stack

- **Frontend:** Next.js 15 (App Router), shadcn/ui, Tailwind CSS, Geist font
- **Backend:** Next.js API Routes (shared with Telegram bot via service layer)
- **Database:** PostgreSQL 16 + Prisma ORM
- **Queue:** BullMQ + Redis 7
- **AI:** OpenAI Whisper API (transcription) + GPT-4o-mini (highlight analysis)
- **Video:** FFmpeg (cutting, cropping, subtitle burn-in) + yt-dlp (URL download)
- **Storage:** Cloudflare R2 (S3-compatible, free egress)
- **Auth:** Auth.js v5 (Google OAuth)
- **Payments:** Stripe (weekly subscriptions)
- **Language:** TypeScript everywhere

## Key Patterns

- **Service layer:** Business logic lives in `packages/shared/src/services/`. Both API routes and the Telegram bot call these functions — never duplicate logic in routes.
- **Job queue:** Video processing is async. API creates a Job record + enqueues to BullMQ. Worker picks it up and runs the pipeline.
- **Pipeline steps:** DOWNLOAD → TRANSCRIBE → ANALYZE → CUT → SUBTITLES → UPLOAD. Each step updates `Job.status`. On failure, `Job.status = FAILED` with error message.
- **Auth:** All `/dashboard` routes are protected via middleware. API routes check `auth()` session.
- **Plan limits:** Defined in `packages/shared/src/config/plans.ts`, not in DB. Checked at API level before enqueuing jobs.

## Common Commands

```bash
docker compose up -d          # start all services
docker compose logs -f web    # follow web logs
docker compose logs -f worker # follow worker logs
npx prisma studio             # visual DB browser
npx prisma db push            # push schema changes
TARGET=production docker compose up -d  # production mode
```

## Environment Variables

See `.env.example` for all required variables. Never commit `.env`.

## Design Style

Vercel-inspired dark theme: black background (#000), white text (#EDEDED), Geist font.
All UI components via shadcn/ui. Dark mode only. English-only web interface.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md project guide"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Monorepo structure with npm workspaces → Task 1
- [x] Prisma schema (User, Job, Clip + Auth.js tables) → Task 2
- [x] Shared types, config, plan limits → Task 3
- [x] Lib clients (Prisma, Redis, R2, BullMQ) → Task 4
- [x] Docker Compose with multi-stage Dockerfiles → Task 5
- [x] Next.js app shell with dark theme + Geist → Task 6
- [x] Auth.js with Google OAuth → Task 7
- [x] User service with plan limit checking → Task 8
- [x] Job service with create/get/list → Task 9
- [x] Clip service with CRUD + trim → Task 10
- [x] Job API routes (POST, GET, SSE stream) → Task 11
- [x] Clip API routes (GET, DELETE, download, trim) → Task 12
- [x] Worker entry point → Task 13
- [x] Download processor (yt-dlp + R2) → Task 14
- [x] Transcribe processor (Whisper API) → Task 15
- [x] Analyze processor (GPT-4o-mini) → Task 16
- [x] Cut processor (FFmpeg vertical crop) → Task 17
- [x] Subtitles processor (ASS + 3 presets) → Task 18
- [x] Pipeline orchestrator → Task 19
- [x] Billing service (Stripe) → Task 20
- [x] Billing API routes → Task 21
- [x] Docker smoke test → Task 22
- [x] CLAUDE.md → Task 23

**Deferred to Plan 2 (Frontend Dashboard + Billing UI):**
- Dashboard layout with sidebar
- Upload zone component (drag & drop + URL)
- Job list + progress UI
- Clip gallery + video player
- Trim editor UI
- Plans page + Stripe checkout UI
- Settings page
- Landing page
- Usage bar component
- Watermark for FREE plan
- R2 48h auto-cleanup

**Placeholder scan:** No TBD/TODO found (except watermark noted as post-MVP polish in pipeline.ts — acceptable, will be in Plan 2).

**Type consistency:** All types reference `@clipfast/shared` exports. `Highlight`, `WhisperSegment`, `TranscriptionResult`, `CreateJobInput`, `TrimClipInput`, `SubtitlePreset` — consistent across services, processors, and pipeline.
