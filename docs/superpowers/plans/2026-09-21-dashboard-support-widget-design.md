# Dashboard Support Widget Design

**Status:** approved direction, awaiting specification review

## Goal

Replace the visible Dashboard Support page entry with a persistent chat widget
that lets a signed-in user contact support without leaving the page they are
working on.

## Experience

- Remove `Support` from the desktop sidebar and mobile navigation.
- Show one compact floating chat button at the bottom-right of every authenticated
  Dashboard route.
- Display the unread reply count on the button, capped at `99+`.
- On desktop, open a panel anchored above the button, approximately 400 px wide
  and no taller than the viewport.
- On mobile, open the same conversation as a bottom sheet that uses most of the
  screen and respects the safe area.
- Close from the header button, Escape, or the backdrop. Closing the panel must
  not clear the current draft or conversation.
- Keep focus handling and labels usable by keyboard and screen-reader users.

## Existing behavior retained

The widget reuses `SupportChat` and the current `/api/support` endpoints. Message
history, optimistic sending, retry, polling, unread marking, Telegram operator
delivery, and first-unread email notification remain unchanged. The current
Dashboard pathname is supplied as message context.

## Compatibility

- Keep `/dashboard/support`, but make it redirect to
  `/dashboard?support=open` so bookmarks and existing email links still work.
- Recognize `support=open` on any Dashboard route and open the widget directly.
- Update future support-reply email links to the query-based Dashboard URL.

## Scope limits

No new database fields, API routes, dependencies, file attachments, live typing,
or separate operator console. This is a presentation change around the support
system already in production.

## Acceptance criteria

1. No Support item is visible in Dashboard navigation.
2. The floating control appears on desktop and mobile without covering primary
   controls.
3. Clicking it opens the existing thread and unread replies become read.
4. Sending, retrying, polling, Telegram delivery, and email notification still
   work.
5. The widget can be closed and reopened without losing an unsent draft.
6. Direct visits to `/dashboard/support` open the widget through a redirect.
7. Automated tests, production build, desktop browser QA, and mobile browser QA
   pass before deployment.
