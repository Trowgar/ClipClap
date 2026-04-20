# ClipFast — Architecture & Technical Design

## Overview

ClipFast is an AI-powered video clipping service that turns long videos into short, subtitle-enhanced clips ready for TikTok, Reels, and Shorts. Users upload a video or paste a URL, and the system automatically transcribes, analyzes highlights, cuts clips, and adds animated subtitles.

**Channels:** Web application + Telegram bot (shared backend)
**Target audience:** Beginner creators, micro-creators, small businesses
**Positioning:** Cheapest and simplest AI clipper on the market (3-5x cheaper than Opus Clip / Vizard)

---

## 1. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | Next.js 15 (App Router) + shadcn/ui + Tailwind CSS | Fast UI development, SSR, component library |
| API | Next.js Route Handlers | Unified endpoints for Web and Telegram |
| ORM | Prisma | Type-safe database access |
| Database | PostgreSQL 16 | Reliable, free, industry standard |
| Job Queue | BullMQ + Redis 7 | Async video processing pipeline |
| Transcription | OpenAI Whisper API (`whisper-1`) | Best quality, multilingual |
| Highlight Analysis | OpenAI GPT-4o-mini | Cost-effective moment detection |
| Video Processing | FFmpeg (CLI via child_process) | Cutting, cropping, subtitle burn-in |
| URL Download | yt-dlp (CLI) | YouTube, TikTok, Twitch support |
| File Storage | Cloudflare R2 | Free egress, S3-compatible, cheap |
| Authentication | Auth.js (NextAuth v5) | Google OAuth + Telegram ID |
| Payments | Stripe | Weekly subscriptions, international |
| Telegram Bot | grammY | Lightweight, TypeScript-native |
| Containerization | Docker + Docker Compose | Isolation, portable dev → prod |
| Language | TypeScript (everywhere) | Single language, type safety |

---

## 2. Project Structure

```
clipclap.io/
├── docker-compose.yml
├── .env.example
├── .env                        # API keys (in .gitignore)
├── packages/
│   └── shared/
│       ├── types/              # TypeScript types (Job, User, Clip, Plan)
│       ├── config/             # Plan limits, model configs, constants
│       └── services/           # Shared business logic
│           ├── job.service.ts
│           ├── clip.service.ts
│           ├── billing.service.ts
│           └── user.service.ts
├── apps/
│   ├── web/                    # Next.js 15 (App Router)
│   │   ├── app/
│   │   │   ├── (auth)/         # Login, callback pages
│   │   │   ├── (dashboard)/    # Main app: upload, gallery, settings
│   │   │   ├── api/
│   │   │   │   ├── auth/       # Auth.js endpoints
│   │   │   │   ├── jobs/       # Job CRUD + SSE progress
│   │   │   │   ├── clips/      # Clip list, download, trim, delete
│   │   │   │   ├── billing/    # Stripe checkout + webhooks
│   │   │   │   └── bot/        # Telegram webhook endpoint
│   │   │   └── layout.tsx
│   │   └── Dockerfile
│   ├── worker/                 # BullMQ worker (video pipeline)
│   │   ├── processors/
│   │   │   ├── download.ts     # yt-dlp URL download
│   │   │   ├── transcribe.ts   # Whisper API call
│   │   │   ├── analyze.ts      # GPT-4o-mini highlight extraction
│   │   │   ├── cut.ts          # FFmpeg cutting + vertical crop
│   │   │   └── subtitles.ts    # ASS generation + FFmpeg burn-in
│   │   ├── index.ts
│   │   └── Dockerfile
│   └── bot/                    # grammY Telegram bot
│       ├── handlers/
│       ├── index.ts
│       └── Dockerfile
├── prisma/
│   └── schema.prisma
└── docs/
```

---

## 3. Data Model

### User

| Field | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| email | String? (unique) | From Google OAuth |
| telegramId | String? (unique) | From Telegram bot |
| name | String? | Display name |
| avatarUrl | String? | From OAuth provider |
| plan | Enum (FREE, STARTER, PRO) | Current subscription plan |
| stripeCustomerId | String? | Stripe customer reference |
| stripeSubscriptionId | String? | Stripe subscription reference |
| createdAt | DateTime | Account creation |
| updatedAt | DateTime | Last update |

### Job

| Field | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| userId | String → User | Owner |
| sourceUrl | String? | YouTube/TikTok/Twitch URL |
| sourceKey | String? | Uploaded file key in R2 |
| originalFilename | String? | Original file name |
| status | Enum | PENDING, DOWNLOADING, TRANSCRIBING, ANALYZING, CUTTING, DONE, FAILED |
| error | String? | Error message if FAILED |
| transcription | Text? | Full transcript from Whisper |
| highlights | Json? | Array of moments from GPT |
| subtitles | Boolean (default: true) | Whether to add subtitles |
| subtitlePreset | String? | "tiktok" / "minimal" / "bold" |
| createdAt | DateTime | Job creation |

### Clip

| Field | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| jobId | String → Job | Parent job |
| userId | String → User | Owner |
| title | String | AI-generated clip title |
| storageKey | String | File key in R2 |
| duration | Int | Duration in seconds |
| startTime | Float | Start position in source video |
| endTime | Float | End position in source video |
| subtitles | Boolean (default: true) | Subtitles enabled |
| subtitlePreset | String? | Applied preset (null if no subtitles) |
| parentClipId | String? → Clip | If this is a re-trimmed version |
| createdAt | DateTime | Clip creation |

### Plan Limits (in code, not DB)

| | FREE | STARTER | PRO |
|---|---|---|---|
| Price | $0 | $3/week | $5/week |
| Videos/week | 2 | 10 | 30 |
| Max duration | 10 min | 60 min | 3 hours |
| Subtitles | Basic | Animated presets | Animated + all styles |
| Telegram bot | No | Yes | Yes |
| Watermark | Yes | No | No |

---

## 4. Video Processing Pipeline

```
Job enters BullMQ queue
         │
         ▼
   ┌─────────────┐
   │  DOWNLOAD    │  URL → yt-dlp downloads to /tmp
   └──────┬──────┘  File → download from R2 to /tmp
         │
         ▼
   ┌─────────────┐
   │ TRANSCRIBE   │  ffmpeg extracts audio (.wav)
   └──────┬──────┘  → OpenAI Whisper API (whisper-1)
         │          → returns segments[] with timestamps + text
         ▼
   ┌─────────────┐
   │  ANALYZE     │  Send transcript to GPT-4o-mini
   └──────┬──────┘  Prompt: "Find 3-5 most engaging moments,
         │          return JSON [{start, end, title, reason}]"
         ▼
   ┌─────────────┐
   │    CUT       │  For each highlight:
   └──────┬──────┘  ffmpeg -ss {start} -to {end} -vf "crop=9:16"
         │          → vertical format output
         ▼
   ┌─────────────┐
   │ SUBTITLES    │  IF subtitles enabled:
   └──────┬──────┘    Generate .ass from Whisper segments
         │            Apply preset (tiktok/minimal/bold)
         │            ffmpeg burn-in subtitles
         │          IF watermark (FREE plan):
         │            ffmpeg overlay watermark
         ▼
   ┌─────────────┐
   │   UPLOAD     │  Upload finished clips to R2
   └──────┬──────┘  Create Clip records in DB
         │          Update Job.status = DONE
         ▼
   Notify user (Web SSE / Telegram message)
```

### Error Handling

- Each step updates `Job.status` — user sees exactly where it failed
- BullMQ retry: 3 attempts with exponential backoff
- On failure: `Job.status = FAILED`, `Job.error` = description
- Temporary files in `/tmp` — cleaned up after job completes (success or failure)

### Limit Enforcement

- Plan limits checked at API level BEFORE enqueuing
- Weekly counter reset via cron job or rolling window query
- Watermark applied at SUBTITLES step for FREE plan

---

## 5. API Endpoints

All endpoints are shared between Web (Next.js API routes) and Telegram bot (via shared service layer).

### Authentication

```
POST /api/auth/[...nextauth]     # Auth.js (Google OAuth)
```

### Jobs

```
POST   /api/jobs                 # Create job (file upload or URL)
       body: { url?, file?, subtitles, subtitlePreset }
       → validate plan limits → create Job → enqueue
GET    /api/jobs                 # List user's jobs
GET    /api/jobs/:id             # Job status + details
GET    /api/jobs/:id/stream      # SSE realtime progress
```

### Clips

```
GET    /api/clips                # List user's clips
GET    /api/clips/:id            # Clip details
GET    /api/clips/:id/download   # Generate presigned R2 download URL
POST   /api/clips/:id/trim       # Re-trim a clip
       body: { start, end, subtitles, subtitlePreset }
DELETE /api/clips/:id            # Delete clip (removes from R2 + DB)
```

### Billing

```
POST   /api/billing/checkout     # Create Stripe checkout session
POST   /api/billing/webhook      # Stripe webhook (subscription events)
GET    /api/billing/subscription  # Current plan, usage, renewal date
```

### Telegram

```
POST   /api/bot/webhook          # grammY webhook endpoint
```

### Service Layer

The Telegram bot does NOT call HTTP endpoints. Both Web API routes and the bot import and call the same service functions:

```
packages/shared/services/
  ├── job.service.ts       # createJob, getJob, getUserJobs, getJobProgress
  ├── clip.service.ts      # getClips, getClip, trimClip, deleteClip
  ├── billing.service.ts   # checkLimits, createCheckout, handleWebhook
  └── user.service.ts      # getOrCreate, linkTelegram, getUsage
```

---

## 6. UI/UX Design

### Visual Style: Vercel-inspired

| Property | Value |
|---|---|
| Background | `#000000` (pure black) |
| Primary text | `#EDEDED` |
| Secondary text | `#888888` |
| Accent | `#FFFFFF` |
| Borders | `#333333` |
| Font | Geist (`geist` npm package) |
| Border radius | `rounded-md` (minimal) |
| Animations | Subtle, `framer-motion` for transitions |
| Theme | Dark only |

### Pages

```
/                          # Landing — hero + demo + pricing
/login                     # Google OAuth login
/dashboard                 # Home — upload zone + recent jobs
/dashboard/jobs/:id        # Job progress + clips gallery
/dashboard/clips/:id       # Clip player + trim editor + download
/dashboard/plans           # Plan comparison + Stripe checkout
/dashboard/settings        # Notifications, Telegram link, account
```

### Dashboard Layout

```
┌──────────────────────────────────────────────────────┐
│  ClipFast                                 [avatar ▾] │
├────────────┬─────────────────────────────────────────┤
│            │                                         │
│  Sidebar   │  Main Content Area                      │
│            │                                         │
│  ● Home    │  ┌─────────────────────────────────┐   │
│  ○ Plans   │  │ Drop video or paste a link       │   │
│  ○ Settings│  │                                  │   │
│            │  │ [Choose file]  [___paste url___]  │   │
│            │  │                                  │   │
│            │  │ ☑ Subtitles   [TikTok style ▾]  │   │
│            │  │          [Process →]             │   │
│            │  └─────────────────────────────────┘   │
│ ────────── │                                         │
│ Usage      │  Recent Jobs                            │
│ ████░░ 3/10│  ┌─────┬────────┬────────┐            │
│ videos/week│  │ Name │ Status │ Clips  │            │
│            │  ├─────┼────────┼────────┤            │
│ Plan:      │  │ ...  │ Done   │ 5      │            │
│ Starter    │  │ ...  │ Cutting│ ...    │            │
│ [Upgrade]  │  └─────┴────────┴────────┘            │
│            │                                         │
├────────────┤                                         │
│ [avatar]   │                                         │
│ john@...   │                                         │
└────────────┴─────────────────────────────────────────┘
```

### Clip Viewer (dashboard/clips/:id)

- Video player with playback controls
- Timeline with draggable start/end handles (trim editor)
- Toggle: subtitles on/off
- Dropdown: subtitle preset selector
- Button: "Save trim" → creates new trimmed clip via re-cut job
- Button: "Download"

---

## 7. Docker & Deployment

### Multi-stage Dockerfiles

Each service uses a single Dockerfile with `development` and `production` targets:

```dockerfile
# Example: apps/web/Dockerfile

# Stage: deps
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage: build (production)
FROM deps AS build
COPY . .
RUN npm run build

# Stage: production
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
CMD ["npm", "start"]

# Stage: development
FROM deps AS development
COPY . .
CMD ["npm", "run", "dev"]
```

Worker Dockerfile additionally installs: `ffmpeg`, `yt-dlp`, `python3` (yt-dlp dependency).

### Docker Compose

```yaml
services:
  web:
    build:
      context: ./apps/web
      target: ${TARGET:-development}
    ports: ["3000:3000"]
    depends_on: [postgres, redis]
    volumes:
      - ./apps/web:/app
      - ./packages/shared:/shared
    env_file: .env

  worker:
    build:
      context: ./apps/worker
      target: ${TARGET:-development}
    depends_on: [postgres, redis]
    volumes:
      - ./apps/worker:/app
      - ./packages/shared:/shared
    env_file: .env

  bot:
    build:
      context: ./apps/bot
      target: ${TARGET:-development}
    depends_on: [postgres, redis]
    volumes:
      - ./apps/bot:/app
      - ./packages/shared:/shared
    env_file: .env

  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: clipfast
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: clipfast
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

volumes:
  pgdata:
```

### Development

```bash
git clone <repo>
cp .env.example .env          # fill in API keys
docker compose up -d           # everything starts
# Web: http://localhost:3000
```

### Production (GCP VM)

```bash
TARGET=production docker compose up -d
```

Optional later: Nginx reverse proxy + Certbot SSL, or Cloudflare proxy for HTTPS.

---

## 8. Environment Variables

```env
# Database
DATABASE_URL=postgresql://clipfast:password@postgres:5432/clipfast

# Redis
REDIS_URL=redis://redis:6379

# Auth
NEXTAUTH_SECRET=<random-secret>
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=<from-google-console>
GOOGLE_CLIENT_SECRET=<from-google-console>

# OpenAI
OPENAI_API_KEY=<key>
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_HIGHLIGHTS_MODEL=gpt-4o-mini

# Cloudflare R2
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-key>
R2_SECRET_ACCESS_KEY=<r2-secret>
R2_BUCKET_NAME=clipfast
R2_PUBLIC_URL=<r2-public-bucket-url>

# Stripe
STRIPE_SECRET_KEY=<stripe-key>
STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret>

# Telegram
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_WEBHOOK_URL=<public-url>/api/bot/webhook
```

---

## 9. MVP Scope

### In Scope (MVP)

- File upload (drag & drop) + URL paste (yt-dlp)
- Video processing pipeline (transcribe → analyze → cut → subtitles)
- 3 subtitle presets: TikTok, Minimal, Bold
- Subtitle toggle (on/off per job)
- Clip trim editor (adjust start/end, re-process)
- Google OAuth login
- Dashboard with sidebar (Home, Plans, Settings)
- Usage tracking and plan limit enforcement
- Stripe weekly subscription (Free, Starter, Pro)
- Watermark on Free plan clips
- Cloudflare R2 storage with 48h auto-cleanup of source files
- Docker Compose (dev + prod targets)
- Vercel-style dark UI with Geist font

### Out of Scope (post-MVP)

- Telegram bot (build after web MVP is stable)
- Telegram payments (crypto)
- Auto-posting to social platforms
- B-roll insertion
- Custom subtitle editor (full font/color/position control)
- Referral program
- Local Whisper (cost optimization)
- Multilingual Telegram bot
