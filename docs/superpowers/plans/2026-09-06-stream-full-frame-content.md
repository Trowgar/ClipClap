# Stream Full-Frame Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the complete source frame in every stream gameplay tile while retaining the enlarged webcam tile.

**Architecture:** Keep stream detection and persisted crop plans unchanged. Compile the stream content branch as a contained full-source foreground over a blurred cover-scaled background, using the same ffmpeg primitives as `safe-fit`; all non-stream filtergraphs remain unchanged.

**Tech Stack:** TypeScript, Vitest, ffmpeg filtergraphs, Docker Compose.

---

### Task 1: Pin the full-frame stream contract

**Files:**
- Modify: `apps/worker/src/__tests__/reframe-filtergraph.test.ts`

- [ ] **Step 1: Replace the old crop assertions with a failing regression test**

The stream test must require a four-way input split, a cover-scaled blurred
background, and a contained foreground produced from the uncropped input:

```ts
it("contains the complete source frame over blur in the content tile", () => {
  const graph = buildFiltergraph(streamPlan()).graph;
  expect(graph).toContain("[0:v]split=4[b0][c0][mbg0][mfg0]");
  expect(graph).toContain(
    "[mbg0]scale=1080:1150:force_original_aspect_ratio=increase,setsar=1,crop=1080:1150,boxblur=luma_radius=20:luma_power=2[contbg]"
  );
  expect(graph).toContain(
    "[mfg0]scale=1080:1150:force_original_aspect_ratio=decrease,setsar=1[contfg]"
  );
  expect(graph).toContain(
    "[contbg][contfg]overlay=x='(W-w)/2':y='(H-h)/2'[cont]"
  );
  expect(graph).not.toContain("crop=w=676:h=ih");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
docker compose exec -T worker-render sh -lc 'cd /app/apps/worker && npx vitest run --root ../.. apps/worker/src/__tests__/reframe-filtergraph.test.ts'
```

Expected: the new test fails because the graph still uses `split=3` and
`crop=w=676:h=ih`.

### Task 2: Compile contained stream content

**Files:**
- Modify: `apps/worker/src/reframe/filtergraph.ts`
- Modify: `apps/worker/src/__tests__/reframe-filtergraph.test.ts`

- [ ] **Step 1: Replace only the stream content branch**

Remove `lastContent` and `contentSegs`. Change the stream input split and
content chains to:

```ts
`[0:v]split=4[b0][c0][mbg0][mfg0]`,
`[mbg0]scale=1080:${geom.outContentH}:force_original_aspect_ratio=increase,setsar=1,crop=1080:${geom.outContentH},boxblur=luma_radius=20:luma_power=2[contbg]`,
`[mfg0]scale=1080:${geom.outContentH}:force_original_aspect_ratio=decrease,setsar=1[contfg]`,
`[contbg][contfg]overlay=x='(W-w)/2':y='(H-h)/2'[cont]`,
```

Keep the base, webcam, enable windows, final content overlay, and subtitle burn
ordering unchanged.

- [ ] **Step 2: Update exact graph expectations**

Update the existing exact stream graph and multi-window tests so they pin the
new content composition and no longer expect a time-varying `content.x` crop.
Retain the no-mutation and non-stream parity assertions.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run:

```bash
docker compose exec -T worker-render sh -lc 'cd /app/apps/worker && npx vitest run --root ../.. apps/worker/src/__tests__/reframe-filtergraph.test.ts apps/worker/src/__tests__/output-geometry.test.ts apps/worker/src/__tests__/render-reframe.test.ts'
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 4: Commit the implementation**

```bash
git add apps/worker/src/reframe/filtergraph.ts apps/worker/src/__tests__/reframe-filtergraph.test.ts
git commit -m "fix(render): preserve full stream content frame"
```

### Task 3: Validate on retained evidence and deploy

**Files:**
- No tracked file changes.

- [ ] **Step 1: Run worker verification**

```bash
docker compose exec -T worker-render sh -lc 'cd /app && npm run typecheck -w @clipclap/worker && npm test -w @clipclap/worker && npm run build -w @clipclap/worker'
```

Expected: typecheck, full worker suite, and worker build exit 0.

- [ ] **Step 2: Rerender the private production sample**

Compile the retained crop plan through the candidate filtergraph, render the
retained source window without altering Postgres/R2, and inspect a contact
sheet. Confirm both horizontal edges of gameplay are visible, the webcam
remains in the top tile, subtitles remain last, and ffprobe reports 1080x1920
with SAR 1:1.

- [ ] **Step 3: Rebuild and recreate only the render worker**

```bash
docker compose up -d --build --no-deps worker-render
```

Expected: `worker-render` is recreated and reaches `Up` state; no other service
is recreated.

- [ ] **Step 4: Verify production runtime**

```bash
docker compose ps worker-render
docker compose logs --since=5m worker-render
docker exec clipclapio-worker-render-1 sh -lc 'grep -F "force_original_aspect_ratio=decrease" /app/apps/worker/src/reframe/filtergraph.ts'
```

Expected: the container is running, logs contain no startup/build/runtime
errors, and the running container contains the new stream composition.
