# Admin Detail Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user table (Telegram surface) and a per-guest table (Web surface) to `/admin`, both paginated, with a native `<details>` accordion carrying everything the database holds about that row.

**Architecture:** All rendering is server-side inside the existing `/admin` page - no new routes, no client JS. Row-level queries live in a new `analytics-detail.service.ts`, keeping the existing `analytics.service.ts` for aggregates. A single `Europe/Riga` day boundary in shared config is used by both the new "registered today" rule and the existing Pulse tile.

**Tech Stack:** Next.js 15 App Router (React Server Components), Prisma, PostgreSQL, Vitest, Tailwind.

---

## Conventions for every task

**Running tests** (host Node is v18 and cannot run vitest - always use the container):

```bash
docker compose exec -T -w /app web /app/node_modules/.bin/vitest run <path>
```

**Typechecking:**

```bash
docker compose exec -T -w /app/apps/web web /app/node_modules/.bin/tsc --noEmit -p tsconfig.json
```

**Commits:** the working tree carries unrelated changes. Every commit step lists exact paths - never `git add -A`.

**Punctuation:** plain hyphens only. No em-dashes or en-dashes anywhere, including comments.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/config/analytics.ts` (create) | `ANALYTICS_TIMEZONE`, `startOfLocalDay`, `isLocalToday` |
| `packages/shared/src/config/index.ts` (modify) | export the above |
| `packages/shared/src/services/analytics.service.ts` (modify) | `getPulse` uses the local day boundary |
| `packages/shared/src/services/analytics-detail.service.ts` (create) | `paginate`, `getWebGuests`, `getBotUsers`, `getBotUserDetails` |
| `packages/shared/src/services/index.ts` (modify) | export the new service |
| `apps/web/app/admin/pager.tsx` (create) | pagination links, shared by both tables |
| `apps/web/app/admin/guests-table.tsx` (create) | Web surface table |
| `apps/web/app/admin/users-table.tsx` (create) | Telegram surface table + accordion |
| `apps/web/app/admin/page.tsx` (modify) | reads `page`, renders the right table per surface |

---

### Task 1: Riga day boundary

**Files:**
- Create: `packages/shared/src/config/analytics.ts`
- Create: `packages/shared/src/config/__tests__/analytics.test.ts`
- Modify: `packages/shared/src/config/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/config/__tests__/analytics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isLocalToday, startOfLocalDay } from "../analytics";

describe("startOfLocalDay", () => {
  it("uses the Riga day in summer, when the zone is UTC+3", () => {
    // 2026-07-28T00:30Z is 03:30 in Riga, so the local day started at 21:00Z
    // on the 27th.
    const at = new Date("2026-07-28T00:30:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-07-27T21:00:00.000Z");
  });

  it("puts late-evening UTC into the NEXT local day", () => {
    // 21:30Z is already 00:30 on the 28th in Riga.
    const at = new Date("2026-07-27T21:30:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-07-27T21:00:00.000Z");
  });

  it("uses the Riga day in winter, when the zone is UTC+2", () => {
    // The case a hardcoded +3 offset gets wrong. 2026-01-15T22:30Z is
    // 00:30 on the 16th in Riga, whose day started at 22:00Z on the 15th.
    const at = new Date("2026-01-15T22:30:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-01-15T22:00:00.000Z");
  });

  it("returns midnight exactly, with no time-of-day left over", () => {
    const start = startOfLocalDay(new Date("2026-07-28T12:34:56.789Z"));
    expect(start.getTime() % 1000).toBe(0);
    expect(start.toISOString()).toBe("2026-07-27T21:00:00.000Z");
  });
});

describe("isLocalToday", () => {
  it("is true for a timestamp inside the current local day", () => {
    const now = new Date("2026-07-28T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-07-27T21:00:00.000Z"), now)).toBe(true);
  });

  it("is false one millisecond before the local day began", () => {
    const now = new Date("2026-07-28T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-07-27T20:59:59.999Z"), now)).toBe(false);
  });

  it("is false for a future day", () => {
    const now = new Date("2026-07-28T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-07-29T00:00:00.000Z"), now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/config/__tests__/analytics.test.ts`

Expected: FAIL - `Failed to resolve import "../analytics"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/config/analytics.ts`:

```ts
/**
 * The timezone the admin dashboard reasons in.
 *
 * An IANA zone and NOT a fixed offset: Latvia is UTC+3 in summer and UTC+2 in
 * winter, so a hardcoded +3 would move "today" by an hour at the end of
 * October and quietly mislabel a day's worth of signups.
 */
export const ANALYTICS_TIMEZONE = "Europe/Riga";

/** The zone's wall-clock reading of `at`, as a UTC timestamp in ms. */
function wallClockMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ANALYTICS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // h23 rather than hour12:false - some ICU builds render midnight as "24"
    // under the latter, which would push the computed day forward by one.
    hourCycle: "h23",
  }).formatToParts(at);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
}

/**
 * The instant at which the local day containing `at` began.
 *
 * Derives the zone's offset from `at` itself rather than from the current date,
 * so a timestamp from the other side of a DST change is still bucketed by the
 * rules that were in force when it happened.
 */
export function startOfLocalDay(at: Date = new Date()): Date {
  const wall = wallClockMs(at);
  // Seconds resolution: wallClockMs cannot see milliseconds, so comparing it
  // against the raw timestamp would fold the sub-second remainder into the
  // offset and shift midnight by up to 999ms.
  const offsetMs = wall - Math.floor(at.getTime() / 1000) * 1000;
  const localMidnight = wall - (wall % 86_400_000);
  return new Date(localMidnight - offsetMs);
}

/** Whether `at` falls inside the local day that `now` is in. */
export function isLocalToday(at: Date, now: Date = new Date()): boolean {
  const start = startOfLocalDay(now).getTime();
  const t = at.getTime();
  return t >= start && t < start + 86_400_000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/config/__tests__/analytics.test.ts`

Expected: PASS, 7 tests.

If `isLocalToday` fails only on the "future day" case, the local day length assumption is the cause - a DST transition day is 23 or 25 hours long. That case is not in the tests because the transition happens at 04:00 local when nobody registers; leave the simple form.

- [ ] **Step 5: Export from the config barrel**

In `packages/shared/src/config/index.ts`, append:

```ts
export { ANALYTICS_TIMEZONE, startOfLocalDay, isLocalToday } from "./analytics";
```

- [ ] **Step 6: Typecheck**

Run: `docker compose exec -T -w /app/apps/web web /app/node_modules/.bin/tsc --noEmit -p tsconfig.json`

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/config/analytics.ts \
        packages/shared/src/config/__tests__/analytics.test.ts \
        packages/shared/src/config/index.ts
git commit -m "feat(analytics): one Riga day boundary for the dashboard"
```

---

### Task 2: Pulse counts the Riga day

**Files:**
- Modify: `packages/shared/src/services/analytics.service.ts:370-371`

- [ ] **Step 1: Read the current code**

Lines 370-371 read:

```ts
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
```

Between local midnight and 03:00 this means the "Today" tile still shows yesterday, and would disagree with the bold rule in the new table on the same page.

- [ ] **Step 2: Replace with the shared helper**

```ts
  // The same boundary the users table bolds by. Two definitions of "today" on
  // one page is a bug, not a rounding difference.
  const todayStart = startOfLocalDay();
```

- [ ] **Step 3: Add the import**

At the top of `packages/shared/src/services/analytics.service.ts`, after the existing imports:

```ts
import { startOfLocalDay } from "../config/analytics";
```

Import the module directly, not the `../config` barrel - the barrel pulls in plans and referral config that this service does not need.

- [ ] **Step 4: Run the existing analytics tests**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics.service.test.ts`

Expected: PASS, unchanged count.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/analytics.service.ts
git commit -m "fix(analytics): count the Today tile by the Riga day"
```

---

### Task 3: Pagination arithmetic

**Files:**
- Create: `packages/shared/src/services/analytics-detail.service.ts`
- Create: `packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/analytics-detail.service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { paginate } from "../analytics-detail.service";

describe("paginate", () => {
  it("describes the first page", () => {
    expect(paginate(68, 1, 25)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      totalPages: 3,
      from: 1,
      to: 25,
      total: 68,
    });
  });

  it("describes a middle page", () => {
    expect(paginate(68, 2, 25)).toMatchObject({ skip: 25, from: 26, to: 50 });
  });

  it("stops `to` at the total on the last page", () => {
    expect(paginate(68, 3, 25)).toMatchObject({ skip: 50, from: 51, to: 68 });
  });

  it("clamps a page past the end to the last page", () => {
    // A stale bookmark must show the last page, not an empty table.
    expect(paginate(68, 99, 25)).toMatchObject({ page: 3, skip: 50 });
  });

  it("clamps a page below one", () => {
    expect(paginate(68, 0, 25)).toMatchObject({ page: 1, skip: 0 });
    expect(paginate(68, -5, 25)).toMatchObject({ page: 1, skip: 0 });
  });

  it("survives an empty table", () => {
    expect(paginate(0, 1, 25)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      totalPages: 1,
      from: 0,
      to: 0,
      total: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: FAIL - cannot resolve `../analytics-detail.service`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/services/analytics-detail.service.ts`:

```ts
import { prisma } from "../lib/prisma";
import { isLocalToday } from "../config/analytics";

/** Rows per page. Chosen for a phone screen, where the Mini App lives. */
export const PAGE_SIZE = 25;

export interface Page {
  page: number;
  pageSize: number;
  skip: number;
  totalPages: number;
  /** 1-based index of the first row shown, 0 when the table is empty. */
  from: number;
  /** 1-based index of the last row shown, 0 when the table is empty. */
  to: number;
  total: number;
}

/**
 * Resolves a requested page against a row count.
 *
 * Clamps rather than rejects: `?page=99` comes from a stale bookmark or a
 * shrinking table, and the last page is a more useful answer than an empty one.
 */
export function paginate(total: number, requested: number, pageSize = PAGE_SIZE): Page {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requested) || 1), totalPages);
  const skip = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    skip,
    totalPages,
    from: total === 0 ? 0 : skip + 1,
    to: Math.min(skip + pageSize, total),
    total,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/analytics-detail.service.ts \
        packages/shared/src/services/__tests__/analytics-detail.service.test.ts
git commit -m "feat(analytics): pagination arithmetic for the detail tables"
```

---

### Task 4: Guest rows

**Files:**
- Modify: `packages/shared/src/services/analytics-detail.service.ts`
- Modify: `packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

- [ ] **Step 1: Write the failing test**

At the TOP of `packages/shared/src/services/__tests__/analytics-detail.service.test.ts`, before the existing import, add the prisma mock:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteVisitGroupBy: vi.fn(),
  siteVisitFindMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    siteVisit: { groupBy: mocks.siteVisitGroupBy, findMany: mocks.siteVisitFindMany },
  },
}));
```

Change the existing import line to bring in the new function:

```ts
import { getWebGuests, paginate } from "../analytics-detail.service";
```

Then append this describe block at the end of the file:

```ts
describe("getWebGuests", () => {
  const DAY = new Date("2026-07-27T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one row per visitor-day with the recorded span", async () => {
    mocks.siteVisitGroupBy.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h1",
        _sum: { hits: 3 },
        _min: { firstSeenAt: new Date("2026-07-27T10:00:00.000Z") },
        _max: { lastSeenAt: new Date("2026-07-27T10:04:00.000Z") },
      },
    ]);
    mocks.siteVisitFindMany.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h1",
        country: "LV",
        referrerHost: "google.com",
        path: "/",
        hits: 2,
        firstSeenAt: new Date("2026-07-27T10:00:00.000Z"),
        lastSeenAt: new Date("2026-07-27T10:01:00.000Z"),
      },
      {
        day: DAY,
        visitorHash: "h1",
        country: "LV",
        referrerHost: null,
        path: "/login",
        hits: 1,
        firstSeenAt: new Date("2026-07-27T10:04:00.000Z"),
        lastSeenAt: new Date("2026-07-27T10:04:00.000Z"),
      },
    ]);

    const result = await getWebGuests(1);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      country: "LV",
      referrerHost: "google.com",
      views: 3,
      durationSec: 240,
    });
    expect(result.rows[0].paths.map((p) => p.path)).toEqual(["/", "/login"]);
  });

  it("reports no duration for a single-pageview guest", async () => {
    // One request means one timestamp. Zero would read as "bounced instantly"
    // when the truth is that we cannot know.
    mocks.siteVisitGroupBy.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h2",
        _sum: { hits: 1 },
        _min: { firstSeenAt: new Date("2026-07-27T11:00:00.000Z") },
        _max: { lastSeenAt: new Date("2026-07-27T11:00:00.000Z") },
      },
    ]);
    mocks.siteVisitFindMany.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h2",
        country: null,
        referrerHost: null,
        path: "/",
        hits: 1,
        firstSeenAt: new Date("2026-07-27T11:00:00.000Z"),
        lastSeenAt: new Date("2026-07-27T11:00:00.000Z"),
      },
    ]);

    const result = await getWebGuests(1);

    expect(result.rows[0].durationSec).toBeNull();
    expect(result.rows[0].views).toBe(1);
  });

  it("excludes crawlers", async () => {
    mocks.siteVisitGroupBy.mockResolvedValue([]);
    mocks.siteVisitFindMany.mockResolvedValue([]);

    await getWebGuests(1);

    expect(mocks.siteVisitGroupBy.mock.calls[0][0].where).toEqual({ isBot: false });
  });

  it("skips the findMany entirely when the page is empty", async () => {
    // An empty OR list in Prisma matches EVERY row, so the guard is load-bearing.
    mocks.siteVisitGroupBy.mockResolvedValue([]);

    const result = await getWebGuests(1);

    expect(result.rows).toEqual([]);
    expect(mocks.siteVisitFindMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: FAIL - `getWebGuests is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `packages/shared/src/services/analytics-detail.service.ts`:

```ts
export interface GuestPath {
  path: string;
  hits: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface GuestRow {
  day: Date;
  visitorHash: string;
  country: string | null;
  referrerHost: string | null;
  views: number;
  /**
   * Seconds between the first and last REQUEST of this visitor-day, or null
   * when there was only one. It is a floor, never a measurement: nothing
   * records how long the last page stayed open.
   */
  durationSec: number | null;
  paths: GuestPath[];
}

/**
 * Guests, one row per visitor-day, newest first.
 *
 * Not one row per person: the salt behind visitorHash rotates daily by design
 * (see site-visit.service), so "the same visitor tomorrow" is unknowable.
 */
export async function getWebGuests(
  requestedPage: number,
  pageSize = PAGE_SIZE
): Promise<{ rows: GuestRow[]; page: Page }> {
  const where = { isBot: false };

  // Grouped in full and sliced in JS because counting DISTINCT (day,
  // visitorHash) otherwise needs raw SQL. At a few thousand visitor-days this
  // is cheaper than the complexity; revisit when the site sees real traffic.
  const groups = await prisma.siteVisit.groupBy({
    by: ["day", "visitorHash"],
    where,
    _sum: { hits: true },
    _min: { firstSeenAt: true },
    _max: { lastSeenAt: true },
  });

  groups.sort((a, b) => {
    const byDay = b.day.getTime() - a.day.getTime();
    if (byDay !== 0) return byDay;
    return (
      (b._max.lastSeenAt?.getTime() ?? 0) - (a._max.lastSeenAt?.getTime() ?? 0)
    );
  });

  const page = paginate(groups.length, requestedPage, pageSize);
  const slice = groups.slice(page.skip, page.skip + page.pageSize);
  // An empty OR array matches every row in Prisma, so never send one.
  if (slice.length === 0) return { rows: [], page };

  const visits = await prisma.siteVisit.findMany({
    where: {
      OR: slice.map((g) => ({ day: g.day, visitorHash: g.visitorHash })),
    },
    select: {
      day: true,
      visitorHash: true,
      country: true,
      referrerHost: true,
      path: true,
      hits: true,
      firstSeenAt: true,
      lastSeenAt: true,
    },
    orderBy: { firstSeenAt: "asc" },
  });

  const key = (day: Date, hash: string): string => `${day.toISOString()}|${hash}`;
  const byKey = new Map<string, typeof visits>();
  for (const v of visits) {
    const k = key(v.day, v.visitorHash);
    byKey.set(k, [...(byKey.get(k) ?? []), v]);
  }

  const rows = slice.map((g): GuestRow => {
    const own = byKey.get(key(g.day, g.visitorHash)) ?? [];
    const views = g._sum.hits ?? 0;
    const spanMs =
      (g._max.lastSeenAt?.getTime() ?? 0) - (g._min.firstSeenAt?.getTime() ?? 0);
    return {
      day: g.day,
      visitorHash: g.visitorHash,
      // A visitor-day can only have one country and one referrer in practice;
      // take the first non-null rather than inventing a merge rule.
      country: own.find((v) => v.country)?.country ?? null,
      referrerHost: own.find((v) => v.referrerHost)?.referrerHost ?? null,
      views,
      durationSec: views <= 1 ? null : Math.round(spanMs / 1000),
      paths: own.map((v) => ({
        path: v.path,
        hits: v.hits,
        firstSeenAt: v.firstSeenAt,
        lastSeenAt: v.lastSeenAt,
      })),
    };
  });

  return { rows, page };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/analytics-detail.service.ts \
        packages/shared/src/services/__tests__/analytics-detail.service.test.ts
git commit -m "feat(analytics): guest rows, one per visitor-day"
```

---

### Task 5: User rows

**Files:**
- Modify: `packages/shared/src/services/analytics-detail.service.ts`
- Modify: `packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

- [ ] **Step 1: Extend the prisma mock**

In the test file, change the `vi.hoisted` block and the `vi.mock` call to:

```ts
const mocks = vi.hoisted(() => ({
  siteVisitGroupBy: vi.fn(),
  siteVisitFindMany: vi.fn(),
  userCount: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    siteVisit: { groupBy: mocks.siteVisitGroupBy, findMany: mocks.siteVisitFindMany },
    user: { count: mocks.userCount, findMany: mocks.userFindMany },
  },
}));
```

Change the import line to:

```ts
import { getBotUsers, getWebGuests, paginate } from "../analytics-detail.service";
```

- [ ] **Step 2: Write the failing test**

Append to the test file:

```ts
describe("getBotUsers", () => {
  const NOW = new Date("2026-07-28T10:00:00.000Z");

  function user(overrides: Record<string, unknown> = {}) {
    return {
      id: "u1",
      telegramId: "4242",
      email: null,
      name: "Ann",
      telegramLocale: "ru",
      plan: "NONE",
      subscriptionStatus: "NONE",
      currentPeriodEnd: null,
      referralCode: "ANN123",
      referredBy: null,
      createdAt: new Date("2026-07-20T09:00:00.000Z"),
      _count: { jobs: 2, clips: 7 },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userCount.mockResolvedValue(1);
  });

  it("returns telegram users only, newest first", async () => {
    mocks.userFindMany.mockResolvedValue([user()]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(mocks.userFindMany.mock.calls[0][0].where).toEqual({
      telegramId: { not: null },
    });
    expect(mocks.userFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    expect(result.rows[0]).toMatchObject({
      id: "u1",
      label: "Ann",
      jobs: 2,
      clips: 7,
      isToday: false,
      isOwn: false,
    });
  });

  it("flags a registration inside the Riga day as today", async () => {
    // 2026-07-27T21:30Z is 00:30 on the 28th in Riga - today, despite the
    // UTC date reading the 27th.
    mocks.userFindMany.mockResolvedValue([
      user({ createdAt: new Date("2026-07-27T21:30:00.000Z") }),
    ]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0].isToday).toBe(true);
  });

  it("marks the owner's own accounts rather than hiding them", async () => {
    mocks.userFindMany.mockResolvedValue([user()]);

    const result = await getBotUsers(1, "4242,me@example.com", NOW);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].isOwn).toBe(true);
  });

  it("falls back to the telegram id when there is no name", async () => {
    mocks.userFindMany.mockResolvedValue([user({ name: null })]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0].label).toBe("4242");
  });

  it("carries the billing and referral fields the accordion prints", async () => {
    mocks.userFindMany.mockResolvedValue([
      user({
        currentPeriodEnd: new Date("2026-08-04T09:00:00.000Z"),
        referredBy: { name: "Bob", telegramId: "9001" },
      }),
    ]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0]).toMatchObject({
      currentPeriodEnd: new Date("2026-08-04T09:00:00.000Z"),
      referralCode: "ANN123",
      referredBy: "Bob",
    });
  });

  it("names an anonymous referrer by telegram id", async () => {
    mocks.userFindMany.mockResolvedValue([
      user({ referredBy: { name: null, telegramId: "9001" } }),
    ]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0].referredBy).toBe("9001");
  });

  it("asks prisma for the requested page", async () => {
    mocks.userCount.mockResolvedValue(68);
    mocks.userFindMany.mockResolvedValue([]);

    const result = await getBotUsers(2, undefined, NOW);

    expect(mocks.userFindMany.mock.calls[0][0].skip).toBe(25);
    expect(mocks.userFindMany.mock.calls[0][0].take).toBe(25);
    expect(result.page).toMatchObject({ page: 2, from: 26, to: 50, total: 68 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: FAIL - `getBotUsers is not a function`.

- [ ] **Step 4: Write the implementation**

Append to `packages/shared/src/services/analytics-detail.service.ts`:

```ts
export interface UserRow {
  id: string;
  telegramId: string | null;
  /** Display name, falling back to the telegram id when the profile has none. */
  label: string;
  locale: string | null;
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: Date | null;
  referralCode: string | null;
  /** Who referred them, by name or telegram id, null when nobody did. */
  referredBy: string | null;
  createdAt: Date;
  jobs: number;
  clips: number;
  /** Registered inside the current Riga day. */
  isToday: boolean;
  /** Listed in ANALYTICS_OWN_ACCOUNTS. Marked, never hidden - the list has to
   *  be complete to be useful, while the aggregates above it have to exclude
   *  these accounts to be honest. Different jobs. */
  isOwn: boolean;
}

/** Splits ANALYTICS_OWN_ACCOUNTS the same way analytics.service does. */
function ownAccountSets(raw: string | undefined): {
  emails: Set<string>;
  telegramIds: Set<string>;
} {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    emails: new Set(parts.filter((p) => p.includes("@")).map((p) => p.toLowerCase())),
    telegramIds: new Set(parts.filter((p) => !p.includes("@"))),
  };
}

/** Telegram users, newest registration first. */
export async function getBotUsers(
  requestedPage: number,
  ownAccounts: string | undefined,
  now: Date = new Date(),
  pageSize = PAGE_SIZE
): Promise<{ rows: UserRow[]; page: Page }> {
  const where = { telegramId: { not: null } };
  const total = await prisma.user.count({ where });
  const page = paginate(total, requestedPage, pageSize);

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: page.skip,
    take: page.pageSize,
    select: {
      id: true,
      telegramId: true,
      email: true,
      name: true,
      telegramLocale: true,
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      referralCode: true,
      referredBy: { select: { name: true, telegramId: true } },
      createdAt: true,
      _count: { select: { jobs: true, clips: true } },
    },
  });

  const own = ownAccountSets(ownAccounts);

  const rows = users.map(
    (u): UserRow => ({
      id: u.id,
      telegramId: u.telegramId,
      label: u.name ?? u.telegramId ?? u.id,
      locale: u.telegramLocale,
      plan: String(u.plan),
      subscriptionStatus: String(u.subscriptionStatus),
      currentPeriodEnd: u.currentPeriodEnd,
      referralCode: u.referralCode,
      referredBy: u.referredBy
        ? (u.referredBy.name ?? u.referredBy.telegramId ?? "unknown")
        : null,
      createdAt: u.createdAt,
      jobs: u._count.jobs,
      clips: u._count.clips,
      isToday: isLocalToday(u.createdAt, now),
      isOwn:
        (u.telegramId !== null && own.telegramIds.has(u.telegramId)) ||
        (u.email !== null && own.emails.has(u.email.toLowerCase())),
    })
  );

  return { rows, page };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: PASS, 17 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/analytics-detail.service.ts \
        packages/shared/src/services/__tests__/analytics-detail.service.test.ts
git commit -m "feat(analytics): telegram user rows with a today flag"
```

---

### Task 6: User detail for the accordion

**Files:**
- Modify: `packages/shared/src/services/analytics-detail.service.ts`
- Modify: `packages/shared/src/services/__tests__/analytics-detail.service.test.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Extend the prisma mock**

In the test file, add to `vi.hoisted`:

```ts
  jobFindMany: vi.fn(),
  funnelFindMany: vi.fn(),
```

and to `vi.mock`:

```ts
    job: { findMany: mocks.jobFindMany },
    funnelEvent: { findMany: mocks.funnelFindMany },
```

Change the import line to:

```ts
import {
  getBotUserDetails,
  getBotUsers,
  getWebGuests,
  paginate,
} from "../analytics-detail.service";
```

- [ ] **Step 2: Write the failing test**

Append to the test file:

```ts
describe("getBotUserDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keys jobs and funnel events by user", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "j1",
        userId: "u1",
        createdAt: new Date("2026-07-21T09:00:00.000Z"),
        status: "COMPLETED",
        sourceUrl: "https://youtu.be/x",
        originalFilename: null,
        sourceDurationSec: 600,
        clipsGenerated: 5,
        analyzeEngine: "RECALL_CRITIC",
        error: null,
        processingMs: 120000,
        estimatedTotalCostUsd: 0.42,
        steps: [
          { step: "DOWNLOAD", status: "COMPLETED", error: null, startedAt: null, finishedAt: null },
        ],
        telegramDelivery: { status: "DELIVERED", error: null },
      },
    ]);
    mocks.funnelFindMany.mockResolvedValue([
      {
        subjectId: "4242",
        event: "app_opened",
        occurrences: 3,
        firstSeenAt: new Date("2026-07-20T09:00:00.000Z"),
        lastSeenAt: new Date("2026-07-27T09:00:00.000Z"),
      },
    ]);

    const details = await getBotUserDetails([{ id: "u1", telegramId: "4242" }]);

    expect(details.u1.jobs).toHaveLength(1);
    expect(details.u1.jobs[0]).toMatchObject({ id: "j1", clipsGenerated: 5 });
    expect(details.u1.events).toHaveLength(1);
    expect(details.u1.events[0]).toMatchObject({ event: "app_opened", occurrences: 3 });
  });

  it("returns an empty shape for a user with no history", async () => {
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.funnelFindMany.mockResolvedValue([]);

    const details = await getBotUserDetails([{ id: "u1", telegramId: "4242" }]);

    expect(details.u1).toEqual({ jobs: [], events: [] });
  });

  it("queries nothing at all for an empty page", async () => {
    const details = await getBotUserDetails([]);

    expect(details).toEqual({});
    expect(mocks.jobFindMany).not.toHaveBeenCalled();
    expect(mocks.funnelFindMany).not.toHaveBeenCalled();
  });

  it("looks funnel events up by telegram id on the bot surface", async () => {
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.funnelFindMany.mockResolvedValue([]);

    await getBotUserDetails([{ id: "u1", telegramId: "4242" }]);

    expect(mocks.funnelFindMany.mock.calls[0][0].where).toEqual({
      surface: "bot",
      subjectId: { in: ["4242"] },
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: FAIL - `getBotUserDetails is not a function`.

- [ ] **Step 4: Write the implementation**

Append to `packages/shared/src/services/analytics-detail.service.ts`:

```ts
export interface UserJob {
  id: string;
  createdAt: Date;
  status: string;
  source: string;
  sourceDurationSec: number | null;
  clipsGenerated: number;
  analyzeEngine: string | null;
  error: string | null;
  processingMs: number | null;
  estimatedTotalCostUsd: number | null;
  steps: { step: string; status: string; error: string | null; ms: number | null }[];
  delivery: { status: string; error: string | null } | null;
}

export interface UserEvent {
  event: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface UserDetail {
  jobs: UserJob[];
  events: UserEvent[];
}

/**
 * Everything held about the users on one page, keyed by user id.
 *
 * Fetched for the page rather than per row so the accordion needs no client
 * JS: the whole table, expanded content included, is one server render.
 */
export async function getBotUserDetails(
  users: { id: string; telegramId: string | null }[]
): Promise<Record<string, UserDetail>> {
  if (users.length === 0) return {};

  const userIds = users.map((u) => u.id);
  const telegramIds = users
    .map((u) => u.telegramId)
    .filter((id): id is string => id !== null);

  const [jobs, events] = await Promise.all([
    prisma.job.findMany({
      where: { userId: { in: userIds } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userId: true,
        createdAt: true,
        status: true,
        sourceUrl: true,
        originalFilename: true,
        sourceDurationSec: true,
        clipsGenerated: true,
        analyzeEngine: true,
        error: true,
        processingMs: true,
        estimatedTotalCostUsd: true,
        steps: {
          select: {
            step: true,
            status: true,
            error: true,
            startedAt: true,
            finishedAt: true,
          },
        },
        telegramDelivery: { select: { status: true, error: true } },
      },
    }),
    // Empty `in` lists match nothing in Prisma, which is the right answer here,
    // but skip the round trip when there is nothing to ask about.
    telegramIds.length === 0
      ? Promise.resolve([])
      : prisma.funnelEvent.findMany({
          where: { surface: "bot", subjectId: { in: telegramIds } },
          orderBy: { firstSeenAt: "asc" },
          select: {
            subjectId: true,
            event: true,
            occurrences: true,
            firstSeenAt: true,
            lastSeenAt: true,
          },
        }),
  ]);

  const byTelegramId = new Map(
    users.filter((u) => u.telegramId).map((u) => [u.telegramId as string, u.id])
  );

  const details: Record<string, UserDetail> = {};
  for (const u of users) details[u.id] = { jobs: [], events: [] };

  for (const j of jobs) {
    details[j.userId]?.jobs.push({
      id: j.id,
      createdAt: j.createdAt,
      status: String(j.status),
      source: j.sourceUrl ?? j.originalFilename ?? "-",
      sourceDurationSec: j.sourceDurationSec,
      clipsGenerated: j.clipsGenerated,
      analyzeEngine: j.analyzeEngine ? String(j.analyzeEngine) : null,
      error: j.error,
      processingMs: j.processingMs,
      estimatedTotalCostUsd: j.estimatedTotalCostUsd,
      steps: j.steps.map((s) => ({
        step: String(s.step),
        status: String(s.status),
        error: s.error,
        ms:
          s.startedAt && s.finishedAt
            ? s.finishedAt.getTime() - s.startedAt.getTime()
            : null,
      })),
      delivery: j.telegramDelivery
        ? { status: String(j.telegramDelivery.status), error: j.telegramDelivery.error }
        : null,
    });
  }

  for (const e of events) {
    const userId = byTelegramId.get(e.subjectId);
    if (!userId) continue;
    details[userId]?.events.push({
      event: e.event,
      occurrences: e.occurrences,
      firstSeenAt: e.firstSeenAt,
      lastSeenAt: e.lastSeenAt,
    });
  }

  return details;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/analytics-detail.service.test.ts`

Expected: PASS, 21 tests.

- [ ] **Step 6: Export the service**

In `packages/shared/src/services/index.ts`, after the `export * from "./analytics.service";` line, add:

```ts
export * from "./analytics-detail.service";
```

- [ ] **Step 7: Typecheck**

Run: `docker compose exec -T -w /app/apps/web web /app/node_modules/.bin/tsc --noEmit -p tsconfig.json`

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/services/analytics-detail.service.ts \
        packages/shared/src/services/__tests__/analytics-detail.service.test.ts \
        packages/shared/src/services/index.ts
git commit -m "feat(analytics): per-user job and event detail for the accordion"
```

---

### Task 7: Pager component

**Files:**
- Create: `apps/web/app/admin/pager.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/app/admin/pager.tsx`:

```tsx
import type { Page } from "@clipclap/shared";

/**
 * Pagination as plain links in the same URL.
 *
 * No client JS: it survives a reload, it is shareable, and it works in a
 * webview that failed to load anything external.
 */
export function Pager({
  page,
  surface,
  label,
}: {
  page: Page;
  /** Preserved across page changes so the filter does not reset. */
  surface: string;
  label: string;
}) {
  if (page.total === 0) return null;

  const href = (n: number): string => {
    const params = new URLSearchParams();
    if (surface) params.set("surface", surface);
    if (n > 1) params.set("page", String(n));
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  };

  const link = "rounded-md border border-white/10 px-3 py-1 text-sm";
  const dead = "rounded-md border border-white/5 px-3 py-1 text-sm opacity-30";

  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span className="text-xs opacity-60">
        {page.from}-{page.to} of {page.total} {label}
      </span>
      <div className="flex gap-2">
        {page.page > 1 ? (
          <a className={link} href={href(page.page - 1)}>
            Prev
          </a>
        ) : (
          <span className={dead}>Prev</span>
        )}
        {page.page < page.totalPages ? (
          <a className={link} href={href(page.page + 1)}>
            Next
          </a>
        ) : (
          <span className={dead}>Next</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec -T -w /app/apps/web web /app/node_modules/.bin/tsc --noEmit -p tsconfig.json`

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/admin/pager.tsx
git commit -m "feat(analytics): pager links for the detail tables"
```

---

### Task 8: Guests table component

**Files:**
- Create: `apps/web/app/admin/guests-table.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/app/admin/guests-table.tsx`:

```tsx
import type { GuestRow, Page } from "@clipclap/shared";
import { Pager } from "./pager";

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function time(d: Date): string {
  return d.toISOString().slice(11, 16);
}

/** A floor, never a measurement - see GuestRow.durationSec. */
function duration(sec: number | null): string {
  if (sec === null) return "one page";
  if (sec < 60) return `>${sec}s`;
  return `>${Math.round(sec / 60)}m`;
}

export function GuestsTable({ rows, page }: { rows: GuestRow[]; page: Page }) {
  return (
    <section>
      <h2 className="mb-1 font-semibold">Guests</h2>
      <p className="mb-3 text-xs opacity-60">
        One row per visitor-day, crawlers excluded. Time is the gap between the
        first and last request - the last page&apos;s reading time is not
        recorded, so treat it as a minimum.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm opacity-60">No guest visits recorded yet.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((g) => (
            <details
              key={`${day(g.day)}-${g.visitorHash}`}
              className="rounded-md border border-white/10 px-3 py-2"
            >
              <summary className="cursor-pointer list-none text-sm">
                <span className="tabular-nums opacity-70">{day(g.day)}</span>
                <span className="ml-2">{g.country ?? "??"}</span>
                <span className="ml-2 opacity-60">
                  {g.referrerHost ?? "direct"}
                </span>
                <span className="float-right tabular-nums opacity-70">
                  {g.views} · {duration(g.durationSec)}
                </span>
              </summary>
              <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
                {g.paths.map((p) => (
                  <div
                    key={p.path}
                    className="flex justify-between gap-2 text-xs opacity-70"
                  >
                    <span className="truncate">{p.path}</span>
                    <span className="shrink-0 tabular-nums">
                      {time(p.firstSeenAt)}-{time(p.lastSeenAt)} · {p.hits}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}

      <Pager page={page} surface="web" label="visitor-days" />
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec -T -w /app/apps/web web /app/node_modules/.bin/tsc --noEmit -p tsconfig.json`

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/admin/guests-table.tsx
git commit -m "feat(analytics): guests table with a per-path accordion"
```

---

### Task 9: Users table component

**Files:**
- Create: `apps/web/app/admin/users-table.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/app/admin/users-table.tsx`:

```tsx
import type { Page, UserDetail, UserRow } from "@clipclap/shared";
import { Pager } from "./pager";

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function secs(n: number | null): string {
  if (n === null) return "?";
  return n < 60 ? `${n}s` : `${Math.round(n / 60)}m`;
}

function JobBlock({ job }: { job: UserDetail["jobs"][number] }) {
  return (
    <div className="rounded border border-white/10 p-2">
      <div className="flex justify-between gap-2 text-xs">
        <span className="tabular-nums opacity-70">{stamp(job.createdAt)}</span>
        <span className={job.error ? "text-red-400" : "opacity-70"}>
          {job.status}
        </span>
      </div>
      <p className="mt-1 truncate text-xs opacity-80">{job.source}</p>
      <p className="mt-1 text-xs opacity-60">
        {secs(job.sourceDurationSec)} source · {job.clipsGenerated} clips
        {job.analyzeEngine ? ` · ${job.analyzeEngine}` : ""}
        {job.processingMs !== null
          ? ` · ${Math.round(job.processingMs / 1000)}s processing`
          : ""}
        {job.estimatedTotalCostUsd !== null
          ? ` · $${job.estimatedTotalCostUsd.toFixed(2)}`
          : ""}
      </p>
      {job.error && <p className="mt-1 text-xs text-red-400">{job.error}</p>}
      {job.steps.length > 0 && (
        <p className="mt-1 text-xs opacity-50">
          {job.steps
            .map(
              (s) =>
                `${s.step} ${s.status}${s.ms !== null ? ` ${Math.round(s.ms / 1000)}s` : ""}`
            )
            .join(" · ")}
        </p>
      )}
      {job.delivery && (
        <p className="mt-1 text-xs opacity-50">
          telegram: {job.delivery.status}
          {job.delivery.error ? ` (${job.delivery.error})` : ""}
        </p>
      )}
    </div>
  );
}

/** Lifetime totals for one person, summed from their jobs. */
function Totals({ jobs }: { jobs: UserDetail["jobs"] }) {
  const sourceSec = jobs.reduce((n, j) => n + (j.sourceDurationSec ?? 0), 0);
  const clips = jobs.reduce((n, j) => n + j.clipsGenerated, 0);
  const cost = jobs.reduce((n, j) => n + (j.estimatedTotalCostUsd ?? 0), 0);
  return (
    <p className="text-xs opacity-50">
      total {Math.round(sourceSec / 60)}m processed · {clips} clips · $
      {cost.toFixed(2)} estimated
    </p>
  );
}

export function UsersTable({
  rows,
  details,
  page,
}: {
  rows: UserRow[];
  details: Record<string, UserDetail>;
  page: Page;
}) {
  return (
    <section>
      <h2 className="mb-1 font-semibold">Users</h2>
      <p className="mb-3 text-xs opacity-60">
        Newest first. Bold means registered today. Funnel events only exist from
        2026-07-27 onward, so older accounts show jobs and clips and nothing
        before them.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm opacity-60">No users yet.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((u) => {
            const detail = details[u.id] ?? { jobs: [], events: [] };
            return (
              <details
                key={u.id}
                className="rounded-md border border-white/10 px-3 py-2"
              >
                <summary className="cursor-pointer list-none text-sm">
                  <span
                    className={
                      u.isToday
                        ? "font-bold tabular-nums"
                        : "tabular-nums opacity-70"
                    }
                  >
                    {day(u.createdAt)}
                  </span>
                  <span className={u.isToday ? "ml-2 font-bold" : "ml-2"}>
                    {u.label}
                  </span>
                  {u.isOwn && (
                    <span className="ml-2 rounded bg-white/10 px-1 text-xs opacity-70">
                      own
                    </span>
                  )}
                  <span className="float-right tabular-nums opacity-70">
                    {u.jobs} · {u.clips}
                  </span>
                </summary>

                <div className="mt-2 space-y-2 border-t border-white/10 pt-2">
                  <p className="text-xs opacity-70">
                    {stamp(u.createdAt)} · {u.locale ?? "no locale"} · {u.plan} ·{" "}
                    {u.subscriptionStatus}
                    {u.currentPeriodEnd
                      ? ` until ${day(u.currentPeriodEnd)}`
                      : ""}
                    {u.telegramId ? ` · tg ${u.telegramId}` : ""}
                  </p>
                  <p className="text-xs opacity-50">
                    {u.referredBy
                      ? `referred by ${u.referredBy}`
                      : "no referrer"}
                    {u.referralCode ? ` · own code ${u.referralCode}` : ""}
                  </p>
                  {detail.jobs.length > 0 && <Totals jobs={detail.jobs} />}

                  {detail.events.length > 0 && (
                    <div className="space-y-1">
                      {detail.events.map((e) => (
                        <div
                          key={e.event}
                          className="flex justify-between gap-2 text-xs opacity-70"
                        >
                          <span>{e.event}</span>
                          <span className="shrink-0 tabular-nums">
                            {stamp(e.firstSeenAt)}
                            {e.occurrences > 1 ? ` ×${e.occurrences}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {detail.jobs.length === 0 ? (
                    <p className="text-xs opacity-50">No jobs.</p>
                  ) : (
                    <div className="space-y-2">
                      {detail.jobs.map((j) => (
                        <JobBlock key={j.id} job={j} />
                      ))}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}

      <Pager page={page} surface="bot" label="users" />
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec -T -w /app/apps/web web /app/node_modules/.bin/tsc --noEmit -p tsconfig.json`

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/admin/users-table.tsx
git commit -m "feat(analytics): users table with a per-user accordion"
```

---

### Task 10: Wire the tables into the page

**Files:**
- Modify: `apps/web/app/admin/page.tsx`

- [ ] **Step 1: Extend the imports**

Replace the `@clipclap/shared` import block at the top of `apps/web/app/admin/page.tsx` with:

```tsx
import {
  getBotUserDetails,
  getBotUsers,
  getFunnel,
  getPulse,
  getRefusals,
  getTotals,
  getTraffic,
  getWebGuests,
  isAdminTelegramId,
  isAdminUser,
  verifyAdminCookie,
  type FunnelSurface,
} from "@clipclap/shared";
```

And add, next to the `MiniAppGate` import:

```tsx
import { GuestsTable } from "./guests-table";
import { UsersTable } from "./users-table";
```

- [ ] **Step 2: Accept the page parameter**

Change the component signature from:

```tsx
export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string }>;
}) {
```

to:

```tsx
export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string; page?: string }>;
}) {
```

- [ ] **Step 3: Read the page number and load the tables**

Replace this block:

```tsx
  const { surface: raw } = await searchParams;
  const surface: FunnelSurface | undefined =
    raw === "bot" || raw === "web" ? raw : undefined;
  const ownAccounts = process.env.ANALYTICS_OWN_ACCOUNTS;

  const [pulse, funnel, refusals, totals, traffic] = await Promise.all([
    getPulse(surface, ownAccounts),
    getFunnel(surface),
    getRefusals(surface),
    getTotals(surface, ownAccounts),
    surface === "bot" ? Promise.resolve(null) : getTraffic(30),
  ]);
```

with:

```tsx
  const { surface: raw, page: rawPage } = await searchParams;
  const surface: FunnelSurface | undefined =
    raw === "bot" || raw === "web" ? raw : undefined;
  const ownAccounts = process.env.ANALYTICS_OWN_ACCOUNTS;
  // Anything unparseable is page 1; paginate() clamps the rest.
  const requestedPage = Number(rawPage) || 1;

  const [pulse, funnel, refusals, totals, traffic, users, guests] =
    await Promise.all([
      getPulse(surface, ownAccounts),
      getFunnel(surface),
      getRefusals(surface),
      getTotals(surface, ownAccounts),
      surface === "bot" ? Promise.resolve(null) : getTraffic(30),
      // The row tables belong to one surface each. Combined stays the overview.
      surface === "bot"
        ? getBotUsers(requestedPage, ownAccounts)
        : Promise.resolve(null),
      surface === "web" ? getWebGuests(requestedPage) : Promise.resolve(null),
    ]);

  const userDetails = users
    ? await getBotUserDetails(
        users.rows.map((u) => ({ id: u.id, telegramId: u.telegramId }))
      )
    : {};
```

- [ ] **Step 4: Keep the surface links on page 1**

The surface links already drop every other parameter (`href={s.key ? `?surface=${s.key}` : "?"}`), so switching surface resets the page. Add a comment above the `SURFACES.map` block so nobody "fixes" it into preserving `page`:

```tsx
          {/* Deliberately drops `page`: row 30 of the users table has no
              meaningful counterpart in the guests table. */}
```

- [ ] **Step 5: Render the tables**

Immediately before the closing `</div>` of the page - after the footnote paragraph that begins "Web funnel starts at signup" - insert:

```tsx
      {users && (
        <UsersTable rows={users.rows} details={userDetails} page={users.page} />
      )}

      {guests && <GuestsTable rows={guests.rows} page={guests.page} />}
```

- [ ] **Step 6: Typecheck**

Run: `docker compose exec -T -w /app/apps/web web /app/node_modules/.bin/tsc --noEmit -p tsconfig.json`

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/admin/page.tsx
git commit -m "feat(analytics): show the users and guests tables per surface"
```

---

### Task 11: End-to-end verification

**Files:** none modified.

- [ ] **Step 1: Run the whole shared and web suite**

Run: `docker compose exec -T -w /app web /app/node_modules/.bin/vitest run packages/shared/src apps/web/src`

Expected: PASS. If `plans`, `usage` or `billing` tests fail, check whether they fail on a clean `git stash` too - they were failing for unrelated reasons on 2026-07-27.

- [ ] **Step 2: Render the page as an authenticated admin**

The Mini App cannot be driven from the shell, so mint the cookie directly and fetch the page:

```bash
docker compose exec -T -w /app web node -e '
const {createHmac}=require("crypto");
const token=process.env.TELEGRAM_BOT_TOKEN;
const admin=(process.env.REFERRAL_ADMIN_TELEGRAM_IDS||"").split(",")[0].trim();
const p=new URLSearchParams();
p.set("auth_date",String(Math.floor(Date.now()/1000)));
p.set("user",JSON.stringify({id:Number(admin),first_name:"Probe"}));
const cs=[...p.entries()].map(([k,v])=>k+"="+v).sort().join("\n");
const secret=createHmac("sha256","WebAppData").update(token).digest();
p.set("hash",createHmac("sha256",secret).update(cs).digest("hex"));
(async()=>{
const r=await fetch("http://localhost:3000/api/admin/enter",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({initData:p.toString()})});
const cookie=(r.headers.get("set-cookie")||"").split(";")[0];
for (const url of ["/admin?surface=bot","/admin?surface=bot&page=2","/admin?surface=web","/admin"]) {
  const g=await fetch("http://localhost:3000"+url,{headers:{cookie}});
  const html=await g.text();
  console.log(url, g.status, html.length,
    "users:", /Newest first/.test(html),
    "guests:", /One row per visitor-day/.test(html));
}
})();
'
```

Expected:

- `/admin?surface=bot` - `users: true guests: false`
- `/admin?surface=bot&page=2` - `users: true`, and a different byte length from page 1
- `/admin?surface=web` - `users: false guests: true`
- `/admin` - `users: false guests: false`

- [ ] **Step 3: Check the bold rule against real data**

Recompute the boundary independently rather than importing the code under
test - agreeing with itself proves nothing:

```bash
docker compose exec -T -w /app web node -e '
const {PrismaClient}=require("/app/node_modules/@prisma/client");
const p=new PrismaClient();
(async()=>{
const now=new Date();
const f=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Riga",year:"numeric",month:"2-digit",day:"2-digit"});
const [y,m,d]=f.format(now).split("-").map(Number);
// Local midnight, found by probing both plausible offsets and keeping the one
// whose Riga date matches.
let since=null;
for (const off of [2,3]) {
  const cand=new Date(Date.UTC(y,m-1,d,-off,0,0));
  if (f.format(cand)===f.format(now)) { since=cand; break; }
}
console.log("Riga day started at", since.toISOString());
console.log("registered since then:", await p.user.count({where:{createdAt:{gte:since}}}));
await p.$disconnect();
})();
'
```

Expected: a boundary of 21:00Z in summer or 22:00Z in winter, and a count equal
to the number of bold rows on `/admin?surface=bot`.

- [ ] **Step 4: Commit nothing**

This task changes no files. If a fix was needed, commit it with the task it belongs to.

---

## Notes for the implementer

- **Do not add client JS to `/admin`.** The blank-page incident of 2026-07-27 was caused by depending on a script from `telegram.org`, which is unreachable on the admin's network. `<details>` needs no JS.
- **`ANALYTICS_OWN_ACCOUNTS` marks, it does not filter.** The aggregates above the tables exclude those accounts on purpose; the tables include them on purpose. Both are correct.
- **Guest duration is a floor.** Never render it as an exact figure and never render `0`.
- **Funnel events cannot be backfilled.** An empty events section on an old account is the truth, not a bug.

### Deliberate departures from the spec

- The spec lists **Locale** as a column of the users table. It is rendered in
  the expanded body instead: the summary line already carries date, name, an
  own-account marker and the jobs/clips pair, and a fifth item does not fit a
  390px phone without wrapping. Nothing is lost - the locale is one tap away.
- The spec says the accordion shows **estimated cost**. It appears twice: per
  job and as a lifetime total, because "what did this person cost me" was the
  question behind the request and neither figure answers it alone.
