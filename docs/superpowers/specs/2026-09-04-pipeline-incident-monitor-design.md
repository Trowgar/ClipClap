# Pipeline Incident Monitor Design

## Goal

Detect terminal pipeline failures immediately and notify the owner without continuously invoking an AI model or mutating jobs.

## Design

Every existing stage worker already receives BullMQ's `failed` event. After a job exhausts its configured attempts, that handler passes the stage, job identity, and error to a small shared notifier. The notifier sends one compact Telegram alert to `SUPPORT_CHAT_ID`. Redis stores each stable error fingerprint with a 24 hour TTL so the same outage does not page repeatedly across users.

The monitor is alert-only. It never restarts containers, edits jobs, retries queues, refunds minutes, contacts customers, or invokes Codex. With no failure, it executes nothing and consumes no model tokens. An incident alert contains the stage, job ID, attempt count, and a bounded error excerpt that can be pasted into Codex for diagnosis.

The Redis claim is atomic across workers. If Telegram delivery fails, the short-lived claim is deleted so another terminal failure can retry the alert. If Redis is flushed, the worst outcome is a duplicate alert. A dead container cannot report its own failure, so host-level uptime monitoring remains a separate future layer.

## Verification

Unit tests cover non-terminal silence, terminal notification, atomic deduplication, failed notification retry, and bounded message content. Deployment verification exercises the notifier with Telegram sending disabled, then confirms all workers start with the new shared code.
