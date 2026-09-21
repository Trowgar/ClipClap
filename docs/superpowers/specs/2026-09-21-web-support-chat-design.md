# Web support chat design

## Goal

Give authenticated Dashboard users a dependable text support conversation
without adding a second operator console or an external support vendor. The
operator continues to work in the existing Telegram support chat. Replies
appear inside the user's Dashboard; a verified email address receives one
notification for the first unread reply.

Success means a user can send a message, see its honest delivery state, receive
and read an operator reply on desktop or mobile, and retry a failed relay
without creating duplicate database messages. Existing Telegram support must
continue to work.

## Scope

Included:

- Authenticated users only, at `/dashboard/support`.
- One continuous text thread per ClipClap user.
- Text messages up to 4,000 characters.
- A Support navigation item and unread reply count.
- Operator notification and reply routing through the configured Telegram
  support chat.
- Polling while the chat is open and immediate refresh when the tab becomes
  visible.
- One email notification on the first unread operator reply, only when the
  user's email is verified.
- Request validation, rate limiting, idempotent client retries, accessible
  loading/error states, and production browser verification.

Excluded:

- Public/guest chat, attachments, screenshots, typing indicators, operator
  presence, promised response times, WebSockets/SSE, multiple tickets, ticket
  assignment, canned replies, search, and a separate operator admin inbox.
- Email replies. The sending domain does not receive mail; email only links
  back to the authenticated Dashboard conversation.
- Merging historical Telegram and web threads. New web messages are keyed by
  user ID; the existing Telegram channel keeps its current behavior.

## Architecture

The Dashboard is the customer interface and Telegram remains the operator
interface:

1. The authenticated web API validates and stores a new inbound message with a
   client-generated idempotency key.
2. It sends a plain-text operator notification through the existing shared
   Telegram notification helper. The notification contains a web-support
   marker, safe account label, user ID, and validated Dashboard context path.
3. A successful relay marks the message sent. A failed relay marks it failed;
   the UI shows Retry and does not claim it was delivered.
4. The operator uses Telegram Reply on that notification. The bot parses the
   web marker, validates the target user, and stores one outbound web message,
   deduplicated by the Telegram chat/message identity.
5. The open Dashboard chat polls for new messages every five seconds and when
   the page regains visibility. Opening the thread marks outbound messages read.
6. If the new outbound message is the first unread reply and the account has a
   verified email, the bot sends a short notification linking to
   `/dashboard/support`. Email failure never hides or rolls back the chat reply.

The database is the source of truth for the web transcript. Telegram is the
operator transport, not the web transcript store. There is no new dependency.

## Data model

Evolve `SupportMessage` instead of adding a parallel ticket system:

- `telegramId` becomes nullable so web-only accounts are valid.
- `surface` is `telegram` for existing rows and `web` for the new thread.
- `userId` identifies every new web message.
- `deliveryStatus` is `pending`, `sent`, or `failed` for inbound web messages;
  outbound web replies are stored as `sent`.
- `dedupeKey` is nullable and unique. Inbound keys combine user ID and the
  browser UUID; outbound keys combine the support chat and Telegram message ID.
- `readAt` is set on outbound web messages when the authenticated user opens
  the thread.
- `contextPath` stores only a validated relative `/dashboard...` path and is
  shown to the operator; arbitrary URLs are rejected.

Existing Telegram rows receive safe defaults and retain their indexes. Web
queries always require both `surface = web` and the authenticated `userId`;
the client never supplies a target user ID.

## APIs and service boundaries

- `GET /api/support`: authenticated thread plus unread count. Returns a bounded
  recent history ordered oldest first.
- `POST /api/support`: authenticated text, browser message ID, and optional
  context path. It validates, rate-limits, creates or reuses the row, attempts
  the Telegram relay, and returns the stored delivery state.
- `POST /api/support/read`: marks this user's sent web replies read. It never
  accepts message or user IDs from the browser.
- A shared support service owns validation-independent persistence, unread
  counting, relay state, idempotency, and read marking. Route handlers own auth
  and request validation. The bot owns parsing operator replies and calls the
  same service to store them.

The rate limit is a simple database count appropriate to current traffic: at
most ten new inbound support messages per user per minute. Increase or replace
it only if measured support volume makes the query material.

## Dashboard experience

`Support` is a normal navigation destination in desktop and mobile navigation,
with a numeric badge when replies are unread. The page contains:

- A short heading that says replies may take time; it does not claim live
  staffing.
- A chronological transcript with clear customer/support alignment and
  timestamps.
- A multiline text field, remaining-character feedback near the limit, and a
  Send button operable by keyboard. Enter inserts a newline; Ctrl/Cmd+Enter
  sends.
- Pending, delivered, and failed states. Failed customer messages have Retry;
  retries use the same browser message ID.
- An empty state inviting the user to describe the issue and include what they
  expected, what happened, and any visible error text without secrets or card
  details.

Polling runs only while the support page is mounted. The navigation unread
badge is computed in the Dashboard layout and refreshes on navigation; it does
not justify site-wide background polling.

## Email behavior

When an operator reply is stored, send an email only if:

- the account has a non-null verified email;
- no earlier unread outbound web reply existed before this reply; and
- this Telegram reply has not already been processed.

The email contains no transcript or sensitive account information. It says
support replied and links to the authenticated Dashboard chat. A failed email
is logged and may be inspected operationally, but the reply remains available
in the web chat. Further replies create no emails until the user opens the chat
and clears unread state.

## Failure handling and security

- All endpoints require an authenticated account and use the session user ID.
- Text is trimmed, must be non-empty, and is capped at 4,000 characters. React
  renders it as text; Telegram receives plain text with no parse mode.
- Operator markers are generated server-side and parsed with an exact anchored
  pattern. A reply for a missing user is rejected in the operator chat.
- Incoming browser UUIDs and Telegram message identities are deduplicated by a
  database unique constraint.
- Telegram relay failure is visible as failed. Retry is explicit. A crash after
  Telegram accepted a message but before the database status update can cause a
  duplicate operator notification; Telegram has no idempotency key, and a
  durable outbox is not justified at current volume. The transcript row remains
  deduplicated.
- Database failure while storing an operator reply produces an explicit
  operator warning; no email is sent and no delivery is claimed.
- Email failure cannot affect message delivery.

## Testing and release

Automated checks cover persistence and idempotency, auth isolation, validation,
rate limiting, retry states, unread/read transitions, marker parsing, operator
reply deduplication, verified/unverified email behavior, and existing Telegram
support regressions.

Production verification uses the synthetic web account and configured support
chat:

1. Send one uniquely labelled web message and confirm it appears once in
   Telegram and once in the web thread.
2. Reply from the support chat and confirm one web reply, unread badge, and one
   accepted notification email when the synthetic address is safely configured
   for delivery; otherwise verify the email branch with the provider test path
   and do not send to a real customer.
3. Open the thread and confirm unread clears; send a second reply and confirm a
   new first-unread notification policy.
4. Exercise a forced relay failure without contacting a customer and confirm
   failed + Retry behavior.
5. Check desktop and mobile layouts, keyboard operation, page errors, public
   asset responses, bot health, and migration status.

Deploy the additive migration first, regenerate Prisma clients, then deploy
shared, bot, and web code. Preserve the prior Next build and database backup.
Rollback code and build artifacts without dropping additive support columns or
restoring an old database over newer conversations.
