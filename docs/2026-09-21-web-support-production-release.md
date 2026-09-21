# Dashboard support release — 21 September 2026

## Composer layout follow-up

Released at `2026-09-21T21:17:20Z` from implementation commit `bb46e29`.
Only `apps/web/components/support-chat.tsx` and its focused component test were
copied into the dirty production workspace. The production build ID is
`OJeEzhngIvRTV9W5ynFlO`; only web was restarted.

- TDD evidence: the new layout assertion failed against the side-by-side
  composer, then the focused support suite passed 15/15 tests after the change.
  Both the isolated candidate build and production build exited zero with only
  the existing BullMQ dynamic-import warning.
- Authenticated production QA passed without sending a support message. At
  1440×1000, the 400×640 dialog contained an aligned 366×80 fixed textarea and
  366×40 full-width button. At 390×844, the viewport-contained panel used an
  aligned 364×80 textarea and 364×40 button. The helper row stayed between the
  controls, the Send icon and label were centered, and there were no page or
  console errors.
- HTTPS recovered after the web-only restart, the container is running with
  restart count 0, and the live container reports the expected build ID.
- Backup and rollback: `/tmp/clipclap-support-composer-release-QmxeWm` contains
  the prior source/test files and complete previous `.next` build. Restore those
  files and `previous-next`, then restart only web. Screenshots and the no-send
  Playwright QA script are stored in the same directory.

Deployed at approximately 16:17 UTC from feature commit `aa2cc06`, layered
onto the existing dirty production workspace without resetting or replacing
earlier sales-path changes. Next build: `b2mZV5dhWCexhOqq0DMhk`.

## Dashboard support widget follow-up

Released at `2026-09-21T18:16:12Z` from approved candidate
`c6aff40f1580f3ac2fd8006bc147feda25cee66f`, again by copying only the
allowlisted differing files into the dirty production workspace. The isolated
candidate build ID was `1OWol1MtAS2JeGugh6qtT`; the production build ID is
`udmznBhefkFz1k2HQm8B5` because the production workspace also contains the
previously released sales-path changes.

- Fresh scoped regression verification passed: 5 files and 29 tests. Web
  TypeScript checking and both the isolated and production Next builds exited
  zero. The existing BullMQ dynamic-import warning was the only build warning.
- Fresh production browser QA passed at 1440x1000 and 390x844 without sending a
  support message. Desktop verified the removed Support navigation item,
  accessible trigger and dialog, non-live header note, unsent-draft retention,
  Escape focus return, legacy redirect, back/forward reopening and backdrop
  click interception. Mobile verified an unobscured trigger, viewport-contained
  bottom sheet, backdrop close, draft retention and no Support navigation item.
  The acceptance run had no page or console errors. A later repeated diagnostic
  run still passed all widget assertions but caused six unrelated background
  route-prefetch/favicon requests to receive edge 429s after sustained QA
  traffic; it did not affect the acceptance run or support endpoints.
- Authenticated HTTPS Dashboard returned 200, observed Next static assets
  returned 200, and the public build manifest returned 200. The web container
  is running with restart count 0 and post-restart logs contain no new errors.
  Screenshots are `support-widget-desktop.png` and
  `support-widget-mobile.png` in the backup directory.
- Runtime scope was web only. The web container alone was restarted; bot and
  workers were not restarted. The running bot may continue emitting the old
  `/dashboard/support` email URL because that route now redirects compatibly to
  `/dashboard?support=open`.
- Follow-up backup: `/tmp/clipclap-support-widget-release-GdAoRi`. It contains
  the exact pre-release source/test files or missing markers, the previous Next
  build `b2mZV5dhWCexhOqq0DMhk`, the new QA script and both screenshots.
- Follow-up rollback: restore the allowlisted source/test files (removing only
  files represented by `.missing` markers), replace the web `.next` volume with
  `previous-next`, and restart only web. Do not reset the workspace or restart
  bot/workers.

## Widget focus containment follow-up

Released at `2026-09-21T18:42:42Z` from reviewed commit
`0218a9c9c8be88d7947b6e1894fe5a8f206706c5`. Only
`apps/web/components/support-widget.tsx` and its focused regression test were
copied into production. The production build ID is
`izE66QvKa126ecIOpmzSh`; only web was restarted.

- The focused suite passed 8/8 tests, and the production Next build exited zero
  with only the known BullMQ dynamic-import warning.
- Interactive production QA proved that opening the modal hides its trigger,
  the hidden trigger cannot receive focus, forward and reverse Tab remain in
  the dialog, and Escape closes the dialog before restoring focus to the now
  visible trigger. Existing desktop and 390x844 mobile lifecycle, draft,
  redirect/history, backdrop and navigation-removal checks also passed.
- Exactly one message was sent:
  `[QA widget focus release 2026-09-21T18:41:25.664Z 40f75747-a80e-4edb-91e0-a7cb01a6975a]`.
  UI showed `Delivered`, and authenticated `GET /api/support` returned exact row
  `cmubld1jf001fr4b84s12he02` with `deliveryStatus: sent`. No operator reply or
  email was created.
- Authenticated Dashboard returned 200 and 20 observed static assets returned
  200. There were no page errors or non-429 console errors. Six unrelated edge
  429s from favicon, analytics and background route-prefetch requests were
  recorded separately; none involved the support API or message delivery.
- Backup: `/tmp/clipclap-support-widget-focus-release-QYdaBD`, containing the
  prior source/test files, release note and complete previous Next build
  `udmznBhefkFz1k2HQm8B5`, plus the QA script and screenshots. Rollback restores
  those two source/test files and `previous-next`, then restarts only web.

## Live behavior

- Authenticated Dashboard users have a floating support trigger on every
  Dashboard route. There is no Support item in desktop or mobile navigation.
  The trigger opens a desktop dialog or mobile bottom sheet and is hidden while
  that modal is open; focus is trapped inside, and Escape closes it and returns
  focus to the visible trigger.
- `/dashboard/support` is compatibility-only and redirects to
  `/dashboard?support=open`, which opens the widget. Query-driven opening also
  works through browser back/forward navigation. Unsent drafts survive explicit
  close/reopen while the mounted Dashboard layout remains active.
- A web message is stored before delivery and relayed to the existing operator
  Telegram chat with an exact `🆕 #web<userId>` reply marker.
- Replying to that marker is stored in the web thread. The first unread reply
  requests one transcript-free email; subsequent unread replies do not send
  another email. Reading marks only the exact reply IDs shown by the browser.
- Five-second polling runs only while the widget is open and the document is
  visible. Delivery is explicit (`Sending`, `Delivered`, `Not sent — Retry`),
  retries preserve the client UUID, and per-user advisory locking enforces ten
  new messages/minute.
- A two-minute stale relay can be retried. A per-attempt `deliveryClaim` fences
  final status updates, so an expired request cannot overwrite its replacement.

## Previous page-era verification (historical)

The evidence below records the original `/dashboard/support` page release.
Navigation and page-specific observations are historical and are superseded by
the current widget behavior and follow-up verification above; backend delivery,
reply, migration and concurrency evidence remains applicable.

- 494 tests passed across 54 web/bot/shared suites. Shared build, web and bot
  typechecks, Prisma validation and the isolated Next production build passed.
  The existing BullMQ dynamic-import warning was the only build warning.
- Three independent review rounds found and then verified fixes for stale
  pending relays, concurrent rate-limit/email/read races, optimistic polling
  reconciliation, stale unread badges, Telegram's 4096-character ceiling and
  claim fencing. Final review reported no deployment blocker.
- Additive migration `20260921153500_web_support_chat` applied; production now
  reports 47 migrations and the expected columns/indexes. Prisma clients were
  regenerated in web, bot and all five worker containers.
- Production browser checks passed on desktop and 390×844 mobile with no page
  errors: contextual Support navigation, keyboard send, Delivered state,
  mobile navigation, unread badge `1 → 0`, visible operator reply and exact-ID
  read clearing. Reposting the same client UUID returned the original row and
  left one matching row.
- Synthetic inbound row `cmubgadtf000sa9bgzwxfwkky` reached Telegram and is
  `sent`. Synthetic reply `cmubgc1md0001rgszyz7pl6ub` went through the real bot
  handler, appeared in web, was read, and has `emailNotifiedAt`, proving the
  provider accepted the notification to the non-customer QA address. The
  operator update itself was injected into the handler rather than sent from a
  human Telegram account.
- Login and all 14 referenced static assets return 200. Web, bot and all five
  workers are running; queues are empty; post-release logs contain no runtime
  error. Analyze/transcribe were restarted in place, preserving custom config.

## Backup and rollback

- Backup directory: `/tmp/clipclap-support-release-rVOppg` contains the
  pre-release PostgreSQL custom dump, source archive, previous/new shared dist,
  previous/new Next build, worker inspect data, browser scripts and screenshots.
- Roll back only the support source delta and restore `previous-shared-dist` and
  `previous-next` while app processes are stopped, then restart the same
  containers in place. Preserve the additive support columns and customer data;
  do not restore the whole database dump over newer transactions.
- The historical `[QA ...]` rows and focus-release row
  `cmubld1jf001fr4b84s12he02` are deliberately labelled synthetic and must not
  be treated as customer feedback or conversion evidence.

Deliberate MVP ceiling: text only, no attachments, typing indicator, live
presence, WebSocket/SSE or separate operator inbox. Telegram remains the
operator console; email is a notification that links back to Dashboard and
never contains the support transcript.
