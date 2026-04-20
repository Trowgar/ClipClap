# ClipClap — Launch Design (Pricing, Retention, Architecture)

**Status:** Design approved — ready for implementation planning
**Date:** 2026-04-19
**Target:** v1 public launch for up to 100 paying customers

---

## Overview

This document specifies three tightly coupled decisions that must ship together for v1 public launch:

1. **Pricing tiers and entitlements** — what users pay, what they get
2. **Storage and billing lifecycle** — how clips are retained, what happens on cancel/downgrade/failed-payment
3. **Runtime architecture** — how the service handles 50–100 daily active users without falling over

These are coupled: pricing caps limit usage (which bounds compute cost), retention defines storage cost, and architecture defines the concurrency budget. Changing one without the others breaks the unit economics.

**Scope boundary:** This is a v1 launch design, not a 12-month platform roadmap. Post-launch scaling (200+ DAU, GPU workers, multi-region) is intentionally out of scope.

**Audience:** ClipClap targets "clippers" — people who generate short viral clips from long-form content (streams, podcasts, movies) for TikTok/Reels/Shorts monetization. Business goal is 100 paying customers on a controlled budget, not competing head-on with OpusClip/Vizard.

---

## 1. Pricing Tiers

### 1.1 Public tier table (what ships on the pricing page)

| Plan | Weekly | Monthly | Min/week | Min/month | Storage | Retention | Subtitle styles | Priority |
|---|---|---|---|---|---|---|---|---|
| **Starter** | $3 | $9 | 75 | 270 | 20 clips | 7 days | 1 (TikTok preset) | normal |
| **Plus** | — | $29 | — | 1,000 | 150 clips | 30 days | 3 presets | normal |
| **Max** | — | $89 | — | 3,500 | 1,000 clips | 90 days | all | priority |

**Design intent:**

- **Starter** is the trial-paid entry. Weekly billing attracts low-commitment users from TikTok/organic traffic. No free tier — resource-constrained launch, and paid entry filters abuse.
- **Plus** is the main revenue driver. Monthly-only by design: removing Plus weekly avoids cannibalization of monthly MRR and reduces churn/dunning overhead.
- **Max** is monthly-only to avoid "burst and ghost" power users who would ruin worker capacity planning on weekly plans.

### 1.2 Top-up packs (usage overages)

Available on all plans. Used before subscription cycle ends, do not roll over.

| Pack | Price | Min included | Effective $/min | Net margin (after Stripe) |
|---|---|---|---|---|
| Small | $6 | 100 | $0.060 | ~70% |
| Large | $15 | 300 | $0.050 | ~70% |

Top-up per-minute price is intentionally 2x the effective Plus monthly rate (~$0.029/min). This preserves the upgrade incentive — a user who regularly buys top-ups is always better off upgrading.

### 1.3 Unit economics assumptions

All margin calculations in this document use the following baselines:

| Cost component | Rate | Source |
|---|---|---|
| OpenAI Whisper API | $0.006 per source-minute | OpenAI pricing, `whisper-1` |
| OpenAI GPT-4o-mini (highlights) | ~$0.00004 per source-minute | 1 API call per job, ~25K input + 1.5K output tokens |
| Server compute (FFmpeg, amortized) | $0.006 per source-minute | ~$270/month infra ÷ 45,000 min/month at 50 DAU |
| R2 storage + operations | ~$0.001 per source-minute averaged | Negligible; included for safety buffer |
| GCP internet egress | Tracked separately | ~$0.12/GB outbound — monitored from day 1 |
| **Total variable cost** | **≈ $0.013 per source-minute** | Used as conservative baseline |
| Stripe payment processing | 2.9% + $0.30 per transaction | Stripe Payments standard |
| Stripe Billing | +0.7% if enabled | Billed subscription features |
| Stripe Tax (EU compliance) | +0.5% if enabled | For VAT-compliant EU B2C sales |

**Cost optimization lever (post-launch):** OpenAI's `gpt-4o-mini-transcribe` is $0.003/min — half of Whisper. If quality is acceptable for ClipClap's use case, migrating drops total cost to ~$0.010/min and materially improves Max margin. A/B test post-launch, do not block MVP on this.

### 1.4 Margins at maximum usage

Computed assuming a user consumes 100% of their minute allotment in a billing period, at the baseline $0.013/min cost, with full Stripe fees.

| Plan | Cost (max) | Revenue | Stripe fees | Net margin |
|---|---|---|---|---|
| Starter weekly $3 | $0.98 | $3.00 | $0.42 | ~53% |
| Starter monthly $9 | $3.51 | $9.00 | $0.67 | ~54% |
| Plus monthly $29 | $13.00 | $29.00 | $1.49 | ~50% |
| Max monthly $89 | $45.50 | $89.00 | $3.95 | ~45% |

In practice, most users will not consume 100% of their minutes. Average usage is typically 30–50% of cap, which pushes real margins 15–25 percentage points higher.

### 1.5 Projected revenue at launch target

At 100 paying customers with a typical B2C SaaS distribution of 35% Starter / 50% Plus / 15% Max:

- Blended ARPU: 0.35×$9 + 0.50×$29 + 0.15×$89 = **$31/month**
- **Monthly Recurring Revenue: ~$3,100**
- Estimated gross profit after OpenAI + compute + Stripe: ~$1,700/month

This comfortably covers fixed infra (~$280/month) and provides buffer for operational expenses.

### 1.6 Abuse protections (hard limits)

Beyond the soft cap of minutes-per-period, all plans enforce:

- **Max source duration per upload:** 3 hours (180 minutes)
- **Max source file size:** 2 GB
- **Max jobs per day:** 20 (Starter), 50 (Plus), 100 (Max)
- **Max queued minutes per user at any time:** matches 7-day allocation (prevents stockpiling)

These are protection limits, not marketing limits. They should only be visible in error messages and ToS, not on the pricing page.

---

## 2. Storage & Retention Policy

### 2.1 Core retention invariant

A clip is kept in R2 and accessible if and only if **both** conditions hold:

1. The clip's age is less than the user's plan retention window (7/30/90 days from creation)
2. The user's total clip count is within their plan's storage quota (20/150/1,000)

If either condition fails, the clip is deleted per the rules below. This invariant is enforceable, explainable, and visible in the UI via a per-clip "expires on" date.

### 2.2 Scenario: retention expired (clip age > plan retention)

Clips whose `expiresAt <= NOW()` are hard-deleted by the hourly cleanup job. No user action required.

**User communication:** Daily digest email sent 24h before expiration listing expiring clips, with download links.

### 2.3 Scenario: over-quota (too many clips)

When a job generates clips that push the user over their count quota:

- **Immediate:** email sent — "You're at X/Y clips. Your oldest N clips will be deleted in 24h. Upgrade or download now to keep them."
- **Immediate:** in-dashboard banner showing at-risk clips
- **24h later:** oldest N unpinned clips hard-deleted

Rationale: This gives the user a grace period without blocking job creation. The user paid for a job — we shouldn't refuse to run it.

### 2.4 Scenario: failed payment (dunning window)

Unified for all plans: **14 days dunning + 7 days read-only grace = 21 days total**.

```
Day 0:  Stripe charge fails
        → Banner + email "Payment failed, we'll retry"
        → New jobs blocked immediately
        → Existing clips remain accessible
Day 3:  Stripe auto-retry
Day 7:  Another retry + "Update your card" email
Day 12: Final retry
Day 14: Subscription canceled
        → Enter 7-day read-only grace (no new jobs, can download clips)
Day 21: Final cleanup per section 2.5
```

### 2.5 Scenario: subscription ended (user cancel or final dunning)

```
Day 0 (sub ends): User enters 7-day grace
                  → Email "Your subscription ended. Clips deleted in 7 days unless you resubscribe."
                  → Dashboard is read-only
                  → Cannot create new jobs
Day 7:  All clips hard-deleted from R2
        Job metadata (transcriptions, highlights) deleted from Postgres
        User account remains (can resubscribe fresh anytime)
```

### 2.6 Scenario: user downgrades plan (e.g. Max → Plus)

Downgrades are **strict** — no grandfathering of retention or quota.

```
At effective date of downgrade:
1. Recompute expires_at for all clips: new_expires = min(old_expires, created_at + new_plan_retention)
2. Hard-delete all clips where new_expires <= NOW()
3. If remaining clip count > new quota, hard-delete oldest until within quota
```

**User communication:** 7-day pre-notice email listing clips that will be deleted at downgrade effective date.

Rationale: The simple invariant (see 2.1) must hold for all users on a given plan. Grandfathering creates a long-tail of users with inconsistent state and hidden storage subsidies.

### 2.7 Scenario: user upgrades plan

Upgrades take effect **immediately** (Stripe prorates the charge):

- Quota increases immediately
- Retention for all existing clips extends to the new plan's window
- Extension is calculated from the date of upgrade, not clip creation: `new_expires = upgrade_date + new_plan_retention`

Rationale: Upgrade should feel like a clear win. Retroactive benefit is psychologically important and simple to implement.

### 2.8 Scenario: explicit account deletion request (GDPR erasure)

**Policy statement:** "Your account is deactivated immediately. All personal data and user-generated content is erased within 30 days, except records we are legally required to retain (billing/tax/dispute/fraud logs per EU and US retention requirements)."

```
Day 0:   Deactivate account (login disabled, no API access)
         Pending jobs canceled
         Active subscription canceled at period end
Within 30 days:
         Hard-delete: clips in R2, job metadata, transcriptions, highlights,
                      user profile, session data
         Retain (per legal obligation): Stripe customer ID and invoice history,
                                        Stripe dispute records,
                                        fraud-prevention logs
```

Key distinction: explicit GDPR erasure does **not** use the normal 30-day soft-delete grace period. Data is purged from systems without recovery.

### 2.9 Scenario: source videos and job artifacts

| Data | Lifecycle |
|---|---|
| Source video (downloaded from URL or user upload) | Deleted from temp storage immediately after `DONE` or `FAILED` job completion (already implemented) |
| Extracted audio (for Whisper) | Deleted immediately after TRANSCRIBE step |
| Transcription text | Stored in `Job.transcription` in Postgres; deleted when clips are deleted (per 2.5, 2.6, 2.8) |
| Highlights JSON | Same lifecycle as transcription |
| Clip files (R2) | Per sections 2.1–2.8 |
| Clip metadata (Postgres rows) | Deleted alongside corresponding R2 files |

### 2.10 Normal cleanup vs. erasure distinction

- **Normal retention cleanup (sections 2.2–2.7):** uses soft-delete pattern. Records marked `deletedAt` initially, R2 files deleted, Postgres rows hard-deleted after 30-day soft-delete window. This enables recovery in case of bugs.
- **Explicit GDPR erasure (section 2.8):** hard-delete only. No soft-delete window. Privacy policy must state this clearly.

### 2.11 Implementation mechanism

BullMQ repeatable job `retention-cleanup`:
- Runs every hour
- Queries `Clip WHERE expiresAt <= NOW() AND deletedAt IS NULL`
- Batches of 100: delete R2 file, mark `deletedAt` in Postgres
- Second pass daily: hard-delete Postgres rows where `deletedAt < NOW() - 30 days` (for normal retention only)

Required Postgres indexes:
```sql
CREATE INDEX idx_clip_retention ON "Clip"(expiresAt, deletedAt);
CREATE INDEX idx_clip_user_created ON "Clip"(userId, createdAt DESC);
```

---

## 3. Runtime Architecture

### 3.1 Capacity model

Target: 100 paying customers, ~50-100 DAU at peak.

**Peak burst estimate:** B2C SaaS typically shows 20-25% of DAU active in a peak hour. For 100 paying users:
- Peak hour concurrent job submissions: ~20-25
- Active jobs at any instant: 3-8 normal, burst to 15-20
- SLA target: end-to-end processing within 15 minutes for 95th percentile

### 3.2 Pipeline bottleneck analysis

| Step | Type | Time per 1h source | Limit |
|---|---|---|---|
| DOWNLOAD | I/O (yt-dlp / R2) | 30–180s | Network, yt-dlp rate limits |
| TRANSCRIBE | API (Whisper) | 30–120s | OpenAI tier limits |
| ANALYZE | API (GPT-4o-mini) | 5–10s | Trivial |
| CUT | CPU (FFmpeg) | 60–300s | **Primary bottleneck** |
| SUBTITLES | CPU (FFmpeg burn-in) | 30–180s | **Secondary bottleneck** |
| UPLOAD | I/O (R2) | 10–60s | Network |

CPU-bound steps (CUT + SUBTITLES) consume 50-80% of total job time. Worker pool must be sized for CPU parallelism, not I/O.

### 3.3 Worker pool — launch capacity

**Launch capacity:** 2 VMs with 4 CPU-bound workers total.

| VM | Machine type | Workers | Notes |
|---|---|---|---|
| web+worker | e2-standard-4 (4 vCPU, 16 GB) | Web server + 0-1 FFmpeg worker | Reserve CPU for API under load |
| dedicated worker | e2-standard-4 (4 vCPU, 16 GB) | 3 FFmpeg workers | Dedicated CPU for processing |

**FFmpeg threading:** `-threads 2` per job to prevent a single FFmpeg invocation from saturating all vCPUs and starving other jobs.

**Scale trigger:** Add a third worker VM (+3 workers, ~$95/month) when either:
- Sustained queue wait time exceeds 5 minutes during peak
- Worker VM CPU sustained above 80% during peak windows

This is monitored, not auto-scaled. Manual capacity decisions are acceptable at this scale.

### 3.4 Queue architecture

Built on existing BullMQ setup. Changes:

**Priority by plan:**
```ts
queue.add("process-video", data, {
  priority: user.plan === "MAX" ? 1 : user.plan === "PLUS" ? 5 : 10,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
});
```
Lower priority value = processed first. This fulfills the "priority processing" commitment on the Max tier.

**Per-user concurrency cap:**

| Plan | Max jobs in flight |
|---|---|
| Starter | 1 |
| Plus | 2 |
| Max | 3 |

**Critical: must be enforced atomically, not via naive `SELECT COUNT(*)`.** Two simultaneous job submissions can both see count < cap and both proceed. Options:
- Postgres: wrap check + insert in a transaction with `SELECT ... FOR UPDATE` on a user-level counter row
- Redis: use a per-user counter with atomic `INCR`/`DECR` and `EXPIRE` for self-heal

Recommend Redis approach for simplicity and speed. Reconcile with Postgres on boot (see 3.10).

### 3.5 OpenAI rate-limit defense

OpenAI rate limits are tier-based and auto-increase with spend. Do not hardcode assumptions about limits; read them from the OpenAI dashboard and tune the app-level limiter.

**App-level limiter:**
- Use a library like `p-limit` or `bottleneck` to cap concurrent Whisper API calls (initial setting: max 15 concurrent, adjust based on observed 429 rates)
- On 429 response: log, allow BullMQ's existing exponential backoff to handle retry
- Alerts: notify on sustained 429 rate > 5% of requests

**Account tier management:** Upgrade OpenAI account to Tier 3+ as soon as possible (~$100 spend + 7 days). Higher tiers have more headroom.

### 3.6 Direct-to-R2 upload flow

Uploads of up to 2 GB must not transit through the Next.js API server (blocks event loop, consumes VM bandwidth).

```
Client: POST /api/jobs/upload-url {filename, contentType}
Server: Validates user auth + plan limits
        Generates R2 presigned PUT URL (15 min expiry)
        Returns {uploadUrl, sourceKey}
Client: PUT file directly to R2 uploadUrl
        On success, POST /api/jobs {sourceKey, subtitlePreset}
Server: Validates sourceKey exists in R2
        Creates Job record, enqueues to BullMQ
Worker: Downloads from R2 via sourceKey for processing
```

Already implemented per existing `r2.ts`. Verify client-side integration in upload component before launch.

### 3.7 API rate limiting

Using `@upstash/ratelimit` (free tier on Upstash Redis, or falls back to our existing Redis):

| Endpoint | Limit |
|---|---|
| `POST /api/jobs` | 10 requests / minute per IP |
| `POST /api/jobs/upload-url` | 10 requests / minute per IP |
| `POST /api/auth/*` | 20 requests / minute per IP |
| Other API endpoints | 60 requests / minute per IP |
| Static assets | unlimited |

### 3.8 Database

**Cloud SQL PostgreSQL:**

For MVP launch, `db-g1-small` (shared-core, $30/month) is acceptable with the explicit understanding that:
- Google Cloud SQL shared-core tiers **are not covered by SLA**
- They are recommended for low-cost dev/test workloads
- We are knowingly accepting this risk for v1; upgrade to smallest dedicated-core (`db-custom-1-3840` or similar, ~$50-70/month) is the first scaling step if issues arise

Connection pooling: Prisma default 10 per worker × 5 workers + 5 from web = ~55 connections. Within `db-g1-small` limit of 100.

**Required indexes** (to add in a Prisma migration):
```sql
CREATE INDEX idx_clip_retention ON "Clip"(expiresAt, deletedAt);
CREATE INDEX idx_clip_user_created ON "Clip"(userId, createdAt DESC);
CREATE INDEX idx_job_user_status ON "Job"(userId, status);
```

**Backups:** Cloud SQL automated backups enabled with 7-day retention. Point-in-time recovery for paid tier only.

### 3.9 Redis

**Memorystore Basic** ($50/month, 1 GB) is sufficient for BullMQ at this scale.

Persistence is **disabled** — job state is durable in Postgres. Redis crash recovery handled by the reconciler (see 3.10).

### 3.10 Reconciler on worker boot

Critical for crash recovery. Runs on every worker startup:

```
1. Query Postgres: Job WHERE status IN ('DOWNLOADING','TRANSCRIBING','ANALYZING','CUTTING')
   AND updatedAt < NOW() - interval '15 min'
2. For each stale job:
   - Check if BullMQ has an active job for it (worker may have actually died)
   - If no active BullMQ job: re-enqueue with one retry attempt
   - If retry count exhausted: mark status FAILED with error "Worker lost"
3. Scan worker heartbeats in Redis (see below)
4. Log reconciliation summary
```

**Worker heartbeat:** each worker writes to `worker:{id}:heartbeat` in Redis every 30 seconds with TTL 90 seconds. Missing heartbeat = worker dead.

### 3.11 Observability (structured JSON logs)

Every log line from worker and API includes:

```json
{
  "timestamp": "2026-04-19T12:34:56.789Z",
  "level": "info",
  "service": "worker",
  "jobId": "abc123",
  "userId": "user_xyz",
  "plan": "PLUS",
  "step": "TRANSCRIBE",
  "attempt": 1,
  "sourceDurationSec": 3600,
  "elapsedMs": 4520,
  "message": "Whisper API call completed"
}
```

**Transport for MVP:** Docker stdout + `docker compose logs`. Post-launch, forward to GCP Cloud Logging (free tier: 50 GB/month) or Papertrail ($7/month).

**Bull-Board UI** (`@bull-board/express`) at `/admin/queues` — auth-gated, for operator debugging.

**Health endpoint** `/api/health`:
- Checks Postgres connection
- Checks Redis ping
- Returns 200 or 503 with details

### 3.12 Failure modes & recovery

| Failure | Impact | Recovery |
|---|---|---|
| Worker OOM or crash | 1 in-flight job stalls | Docker `restart: unless-stopped` + reconciler on boot (3.10) |
| Redis down | Queue stalls, new jobs rejected | Manual restart; reconciler handles resume |
| Postgres down | Full outage | Cloud SQL manual restart. No HA at shared-core tier. |
| OpenAI 429/5xx | Job fails, retries | BullMQ exponential backoff |
| yt-dlp HTTP 429 from source site | Download fails | Retry with backoff. Future: rotating proxy pool |
| Caddy crash | Site unreachable | Docker restart. Caddy has built-in certs persistence. |
| R2 transient error | Job retries | BullMQ handles. R2 has high uptime. |
| Worker VM disk fills | Jobs fail on write | Monitor disk; clear temp files aggressively post-job |

### 3.13 Cost model

| Line | $/month |
|---|---|
| web VM (e2-standard-4) | 95 |
| worker VM (e2-standard-4) | 95 |
| Cloud SQL db-g1-small | 30 |
| Memorystore Basic Redis | 50 |
| R2 storage + operations (at 100 users, ~10 GB) | 5–10 |
| GCP internet egress (outbound to R2, APIs) | 10–30 (monitored day 1) |
| **Fixed infra subtotal** | **~$285–310** |
| OpenAI API (variable, 100 DAU projection) | 400–600 |
| Stripe fees (variable, ~4% revenue) | ~120 at $3,100 MRR |
| **Total operating cost** | **~$800–1,030/month** |
| **Target revenue** | **$3,100 MRR (100 paying)** |
| **Net margin** | **~65–75%** |

### 3.14 Out of scope for v1 (post-launch candidates)

- GPU-accelerated FFmpeg workers (requires benchmarking actual filter graph, not assumption-driven)
- `gpt-4o-mini-transcribe` migration (A/B test quality first)
- Auto-scaling worker pool (manual capacity at this scale)
- Postgres read replicas
- Multi-region deployment
- Rotating proxy pool for yt-dlp
- Advanced observability (Grafana, APM)

---

## 4. Migration from Current State

Current state (as of 2026-04-19):
- Landing page and auth (Google OAuth via NextAuth.js) deployed at `https://clipclap.io`
- Infrastructure: single GCP VM (34.107.43.208) running web + worker + postgres + redis via Docker Compose
- Caddy reverse proxy with Let's Encrypt SSL
- Pipeline functional with `FREE/STARTER/PRO` plan names (needs rename)
- 2 workers, no priority queue, no per-user concurrency, no retention cleanup

**Key deltas from current state to v1:**

1. **Pricing model change:** drop FREE plan; rename STARTER → same, rename PRO → MAX; add PLUS as new middle tier. Update `plans.ts`, Prisma `Plan` enum, and all references.
2. **Stripe product setup:** create 4 products (Starter weekly, Starter monthly, Plus monthly, Max monthly), 2 top-up prices. Wire `priceId` into config.
3. **Second VM:** provision dedicated worker VM on GCP, update docker-compose to push worker-only stack.
4. **Retention cleanup job:** add BullMQ repeatable job + implement all scenarios from section 2.
5. **Stripe webhook handlers:** `invoice.payment_failed`, `invoice.payment_succeeded`, `customer.subscription.deleted`, `customer.subscription.updated`.
6. **Per-user concurrency:** Redis-based atomic counter.
7. **App-level OpenAI limiter:** bottleneck/p-limit with configurable concurrency.
8. **Direct-to-R2 uploads:** verify client integration, test for large files (up to 2 GB).
9. **API rate limiting:** Upstash Ratelimit on critical endpoints.
10. **Structured JSON logging:** replace console.log with a logger (pino recommended).
11. **Worker heartbeat + reconciler:** prevent zombie jobs on worker crash.
12. **Postgres indexes:** migrate to add indexes from section 3.8.
13. **Health endpoint + Bull-Board:** operator tooling.

---

## 5. Success Criteria

v1 launch is considered successful if, for 30 days after launch:

- 95th percentile end-to-end job time ≤ 15 minutes during peak
- No job stuck in processing state > 30 minutes without failing cleanly
- Zero data loss incidents (clips disappearing before their expiration)
- Zero billing errors (users charged wrong amount, double-charged, or not downgraded on cancel)
- OpenAI 429 rate < 1% of total requests
- Net margin across all paying users ≥ 50% (allowing for unexpected usage patterns)

Target commercial outcome: 100 paying customers within 90 days of launch, $3,000+ MRR.
