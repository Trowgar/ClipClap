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
