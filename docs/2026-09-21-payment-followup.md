# Payment follow-up — 2026-09-21

Read-only production diagnosis via `docker compose exec -T web` in
`/srv/dev/clipclap.io`, around 14:23–14:27 UTC. Only Prisma reads and provider
GET/list calls were used. No recipient contact details or credentials are
included. No messages, charges, refunds, deployment, or commits were made.

## Stripe: three people, five sessions

Direct Stripe API results: all five real sessions are `expired` / `unpaid`,
with null PaymentIntent and subscription. Account-wide Charges and
PaymentIntents lists are empty; the sessions list has no additional page.
Synthetic and configured own accounts were excluded using DB identity fields
without printing those fields.

| User ID | September dates | Subtotal / total (USD) |
|---|---|---|
| cmtwezdgz00etlkiq9dk52d48 | 11, 14, 17 | 3.00 / 3.33; 3.00 / 3.00; 3.00 / 3.00 |
| cmu23cnso00jtsv59yfu3vujs | 15 | 3.00 / 3.00 |
| cmu9s4lqz000w5stqdfme6025 | 20 | 3.00 / 3.00 |

The first session's `total_details.amount_tax` is 33 cents; discount and
shipping are zero. The previously unexplained price difference is tax, not a
different base price. The underlying reason for that tax determination was
not established. Each session offers `card` and `cashapp`; this does not prove
which method a person selected, or that they saw the hosted page.

Provider session IDs, in chronological order per user:

- cmtwezdgz00etlkiq9dk52d48:
  `cs_live_a1I59GNHkVWqXUCXVUkjatj0MwUuwbak5c9jrnXNnJJDOyjHBhclBGgj9N`,
  `cs_live_a1XaoH8cRVc2V2IoK8nznUptVIMx1gB8yJqxOndxPdupLwIMaBnaADYXjS`,
  `cs_live_a1QRjGwqTPPc46pqcQU6SAgum4VT7M1KLDFh4EtLBw0tVWPoc2S1ApheS7`.
- cmu23cnso00jtsv59yfu3vujs:
  `cs_live_a1t846buoJohCA12n30tUBp3Hq3ZDgbpooTk4VKv9QT1Ma2pwxz7iecQ51`.
- cmu9s4lqz000w5stqdfme6025:
  `cs_live_a1RjPdrXbYOUNyRDCDxRsy3U3bI0PHv5h4mulBljH0OZFs2r030C6yce3A`.

Classification: expired unpaid Checkout, not a confirmed failed charge.
No PaymentIntent `last_payment_error` or Charge decline code exists to inspect.
Browser display, abandonment, payment-method selection, and customer intent
cannot be reconstructed from these responses. No claim of bank rejection is
supported.

## Tribute: two confirmed failed renewals

| User ID | Order UUID | Initial paid transaction | Failure webhooks (UTC) | Cancellation |
|---|---|---|---|---|
| cmtj80j9e00963jdz501cuc0v | 95d3539a-917a-47be-b37c-7ce171da29ca | 28382730; Sep 1 22:13:06; €3 | Sep 8 22:15:10; Sep 9 00:20:08, 06:25:21 | Sep 9 06:25:21; charge_failed |
| cmtpjpi5y000d10hhosp40jdz | 7de61324-69b0-47fa-8831-772346153d51 | 28590013; Sep 6 16:19:10; €3 | Sep 13 16:20:13, 18:25:10; Sep 14 00:30:08 | Sep 14 00:30:08; charge_failed |

Read `/shop/orders/{uuid}`, `/status`, and `/transactions`: all HTTP 200.
Both orders remain provider `paid` with `memberStatus: cancelled`, consistent
with initial payment followed by failed renewal. Each transaction list contains
only the initial payment, with empty `nextFrom`. Both report
`paymentMethod: smart_glocal`, `paymentType: new_card`, €0.30 service fee and
€2.70 net. These describe the initial payment, not the precise renewal failure.

Stored failure webhook payloads expose order UUID, amount/currency, period,
membership expiry/status and `chargeRetries`; cancellation exposes
`cancelReason: charge_failed`. No processor decline code, bank reason, or
failed-transaction diagnostic was present in the inspected payloads or GET
responses. Provider support/dashboard might have additional diagnostics; that
was not established and no support message was sent. Quality complaints do
not establish voluntary cancellation in these two cases.

At 14:27:02 UTC, all **23** locally FAILED Tribute orders return provider
`pending`. This is a later snapshot than the audit's 18 FAILED. The reconcile
code maps pending/prepaid older than 24 hours to local FAILED. These statuses
are consistent with local expiry, not proof of 23 rejected charges. Conversely,
pending does not rule out a prior card decline: Tribute documents that a
declined card leaves the order pending and payable. No full failed-attempt
history for these 23 orders was obtained.

## Minimal billing change and integration requirements

`billing.service.ts` now requires Checkout `payment_status === paid` before
subscription activation, top-up credit, payment telemetry or notification.
`checkout.session.async_payment_succeeded` shares that handler. An unpaid
completed event is recorded as processed, but its separate async-success event
can subsequently fulfill. Async failure never fulfills. Current Checkout
creation has no trial configuration: `no_payment_required` does not count as
paid and is not fulfilled by this handler. Supporting free/trial Checkout
later requires an explicit entitlement policy separate from paid conversion.

Existing lifecycle behavior remains: invoice success updates an already linked
subscription; subscription updates find users by subscription ID; initial
Checkout creates that linkage. Initial invoice conversion is deliberately
excluded by `billing_reason`; renewal conversion requires `subscription_cycle`,
`invoice.paid` and positive `amount_paid`.

Main's `recordConversionEvent(surface, subject, event, detail?, eventKey?)`
integration is called after fulfillment with:

- Initial subscription/top-up: `payment_succeeded`, user ID, detail containing
  provider, session ID, mode (and subscription ID for subscriptions), key
  `stripe:checkout:<sessionId>`.
- Paid renewal: same event, invoice/subscription IDs and billing reason, key
  `stripe:invoice:<invoiceId>`.

The existing aggregate subscription `recordFunnelEvent` is retained. Main must
not automatically append a second conversion for this aggregate call, as agreed.
No funnel service or schema edits were made by this task.

**Production setup blocker:** endpoint `we_1U5Q71DroBbNEpEwNQmtBUt4` is enabled,
API `2025-02-24.acacia`, but its enabled events omit
`checkout.session.async_payment_succeeded`. Main must enable delivery of that
event before claiming delayed-payment support is live. No endpoint was changed.
Global Stripe SDK/API versions were not changed.

Idempotency limits: the existing webhook-event lookup skips sequential repeats
of the same event ID. Effects occur before the processed row is inserted, so
concurrent deliveries or a crash between effect and insert can still repeat
credits/notifications. Conversion keys deduplicate telemetry only, not financial
effects. Event ordering, delayed old subscription events, and fulfillment-level
transactional idempotency remain existing limitations; this patch does not
claim to solve them. Async settlement may also arrive after an initial invoice
event; the new handler establishes the subscription linkage then.

## Three drafts — not sent; main decides

1. To cmtwezdgz00etlkiq9dk52d48:
   «Здравствуйте! Разбираемся с оплатой ClipClap: 11, 14 и 17 сентября были
   созданы страницы оплаты, но завершённой оплаты мы не видим. Открылась ли
   сама страница? Если пробовали оплатить, на каком шаге остановились и какой
   текст ошибки увидели? Можно прислать только текст ошибки без реквизитов.
   Если просто решили пока не покупать, это тоже поможет понять ситуацию.»
2. To cmtj80j9e00963jdz501cuc0v:
   «Здравствуйте! Оплата ClipClap от 1 сентября прошла, но Tribute сообщил о
   неудачных попытках продления 8–9 сентября. Причину он нам не передал.
   Было ли у вас уведомление с причиной или запрос подтверждения платежа?
   Если да, подскажите текст без реквизитов карты. Повторно оплачивать для
   проверки не нужно.»
3. To cmtpjpi5y000d10hhosp40jdz:
   «Здравствуйте! Оплата ClipClap от 6 сентября прошла, а продление
   13–14 сентября не удалось. Хотим понять именно платёжную проблему:
   показывал ли Tribute или банк причину либо запрос подтверждения?
   Достаточно текста уведомления без реквизитов карты. Повторно оплачивать
   для проверки не нужно.»

## Verification and sources

Before implementation, the isolated billing test run had 4 new failing cases
and 18 passing cases, reproducing unpaid subscription activation and top-up
credit. After implementation, all 26 billing tests passed, and the combined
billing, subscription-reconcile, subscription-state, and tribute-reconcile run
passed all 56 tests. `git diff --check` passed. Commands:

```sh
docker exec clipclap-sales-check-20260921 sh -lc 'cd /app && npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts'
docker exec clipclap-sales-check-20260921 sh -lc 'cd /app && npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts packages/shared/src/services/__tests__/subscription-state.test.ts packages/shared/src/services/__tests__/tribute-reconcile.service.test.ts'
```

Provider documentation consulted:
[Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment),
[Checkout payment status](https://docs.stripe.com/api/checkout/sessions/object),
[Tribute order and transaction API](https://wiki.tribute.tg/for-shops/api/methods),
[Tribute webhook fields](https://wiki.tribute.tg/for-shops/api/webhooks).
Production facts above come from the direct API/DB reads, not inferred from
documentation examples.

## Authorized diagnostic outreach — actual receipts

As targeted follow-up within the requested implementation, the release agent
sent one diagnostic email and two Telegram diagnostics. The agent checked the
September 20 promotional email and treated it as distinct from this diagnostic;
the user did not separately approve that duplicate classification. No marketing
resend, payment retry or charge.

- User `cmtwezdgz00etlkiq9dk52d48`: Resend accepted diagnostic email at
  **2026-09-21T14:56:51.838Z**, receipt
  `01a0c478-45fb-701c-8955-186899e6472c`.
  Idempotency key: `sales-payment-followup-20260921:cmtwezdgz00etlkiq9dk52d48`.
  Subject: “Help us check ClipClap checkout”. English, generic checkout
  questions; no dates or private purchase history. Explicitly says not to
  reply by email, directs to https://t.me/clipclapio_bot → Help → Support,
  requests error text without card details, and says no payment retry needed.
  Provider accepted only; delivery/read and reply remain unknown.
- User `cmtj80j9e00963jdz501cuc0v`: Telegram accepted Russian diagnostic at
  **2026-09-21T14:57:35.429Z**, message ID `6745`.
  After acceptance, set `supportOpen=true` and recorded outgoing support row
  `cmubdd4hk0000ly0nhag22oi1`. Operator reply thread message `6746` accepted
  at **2026-09-21T14:57:35.543Z**.
- User `cmtpjpi5y000d10hhosp40jdz`: Telegram accepted Russian diagnostic at
  **2026-09-21T14:57:35.619Z**, message ID `6747`.
  After acceptance, set `supportOpen=true` and recorded outgoing support row
  `cmubdd4lk0001ly0ngg388gip`. Operator reply thread message `6748` accepted
  at **2026-09-21T14:57:35.700Z**.

Both Telegram messages used the corresponding dated draft above, explicitly
said replies here reach support, requested no card details and no payment
retry. Operator notifications used the existing reply-routing marker in the
configured support chat; no recipient Telegram IDs are copied into this doc.
Both outgoing support rows were read back successfully. Provider acceptance
does not prove delivery/read; replies remain unknown. Exactly one customer
email and two customer Telegram messages were accepted, plus the two explicitly
authorized operator thread notifications. No send was retried.
