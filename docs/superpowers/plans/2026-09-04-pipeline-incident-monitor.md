# Pipeline Incident Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alert the owner immediately after a pipeline job exhausts its retries, without model-token use or automatic remediation.

**Architecture:** Add one event-driven notifier to the shared package and call it from the existing BullMQ worker `failed` event only on the terminal attempt. Atomically deduplicate stable error fingerprints in Redis and send alerts through the existing Telegram notification helper.

**Tech Stack:** TypeScript, Prisma, BullMQ, Redis, Vitest

---

### Task 1: Failure notifier

**Files:**
- Create: `packages/shared/src/services/pipeline-incident-monitor.service.ts`
- Create: `packages/shared/src/services/__tests__/pipeline-incident-monitor.service.test.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] Write tests proving one alert, atomic Redis deduplication, retry after Telegram failure, and bounded content.
- [ ] Run the focused test and confirm it fails because the service does not exist.
- [ ] Implement the minimal fingerprint, atomic claim, bounded alert, and 24-hour Redis key.
- [ ] Export the service and run the focused test to green.

### Task 2: Worker event integration

**Files:**
- Modify: `apps/worker/src/worker-app.ts`
- Test: `apps/worker/src/__tests__/worker-app.test.ts`

- [ ] Add a failing test proving only the terminal attempt reports an incident.
- [ ] Call the notifier from the existing worker failure event after attempts are exhausted.
- [ ] Run focused shared and worker tests.

### Task 3: Deploy alert-only monitor

**Files:**
- No source changes.

- [ ] Run shared and worker typechecks and focused tests.
- [ ] Rebuild and restart all five stage workers.
- [ ] Exercise the notifier with Telegram sending disabled and verify all workers are healthy.
- [ ] Confirm no customer-facing or job-mutating action is present in the implementation.
