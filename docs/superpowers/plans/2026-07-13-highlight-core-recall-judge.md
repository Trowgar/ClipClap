# Highlight Core Recall-Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-pass gpt-4o-mini highlight analyzer with the Recall-Judge engine from the approved spec `docs/superpowers/specs/2026-07-13-highlight-core-recall-judge-design.md`: sentence-graph spine, recall scanner, strict critic, code-owned boundaries, descriptions, language handling, long-video chunking, A/V normalization, honest 0-clip outcomes - all behind env flags with the legacy path intact.

**Architecture:** New `apps/worker/src/analyze-v2/` module implements the engine as small pure units (graph, windows, candidates, snap, gates, select) plus LLM plumbing (prompts, llm wrapper, scanner, critic) and an orchestrator. Existing `processors/analyze.ts` is kept verbatim as V1; `stages/analyze.ts` dispatches by `ANALYZE_ENGINE`/`ANALYZE_V2_PCT`. Transcribe gains language capture + chunking; download gains A/V normalization; render persists new Clip fields.

**Tech Stack:** TypeScript, vitest (tests run inside the worker container), OpenAI SDK v4 (chat.completions + json_schema structured outputs), ffmpeg/ffprobe (in worker container), Prisma migrations (run inside containers; postgres is only reachable in-network).

**House rules that apply to every task:**
- Plain hyphens only in strings/comments - never em/en dashes.
- Commit identity is the repo default (Trowgar); NO Claude attribution trailers.
- After any Prisma schema change: `docker compose exec web npx prisma migrate deploy && docker compose exec web npx prisma generate && docker compose exec worker npx prisma generate && docker compose exec worker npm run build -w @clipclap/shared` (worker runs shared `dist`, web runs `src`).
- Run a single test file: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/<file>.test.ts`
- Typecheck worker: `docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"`
- Source is bind-mounted - code changes hot-reload, no rebuild needed (npm-dep changes would need `--build`; this plan adds no new npm deps).

---

## File map

**Create (engine):**
- `apps/worker/src/analyze-v2/config.ts` - env-backed tunables, one loader
- `apps/worker/src/analyze-v2/types.ts` - SentenceNode, ScanWindow, ScanCandidate, MergedCandidate, CriticVerdict, SnappedClip, V2Result
- `apps/worker/src/analyze-v2/sentence-graph.ts` - buildSentenceGraph
- `apps/worker/src/analyze-v2/windows.ts` - buildScanWindows, renderWindowText
- `apps/worker/src/analyze-v2/candidates.ts` - mergeCandidates, selectCriticCandidates
- `apps/worker/src/analyze-v2/snap.ts` - snapNodes
- `apps/worker/src/analyze-v2/language.ts` - whisperLanguageToIso, dominantScript, scriptMismatch
- `apps/worker/src/analyze-v2/gates.ts` - evidenceGate, snippetFallbackCopy, lexicalOverlap
- `apps/worker/src/analyze-v2/select.ts` - selectAndOrder
- `apps/worker/src/analyze-v2/prompts.ts` - SCANNER_PROMPT, CRITIC_PROMPT, criticUserPrompt builders
- `apps/worker/src/analyze-v2/schemas.ts` - SCANNER_SCHEMA, CRITIC_SCHEMA (json_schema bodies)
- `apps/worker/src/analyze-v2/llm.ts` - callJsonSchema wrapper (retry, truncation, refusal, usage)
- `apps/worker/src/analyze-v2/scanner.ts` - runScanner
- `apps/worker/src/analyze-v2/critic.ts` - runCritic, repairCopy
- `apps/worker/src/analyze-v2/index.ts` - analyzeHighlightsV2 orchestrator

**Create (pipeline):**
- `apps/worker/src/processors/audio-chunks.ts` - parseSilences, planChunks, stitchTranscripts
- `apps/worker/src/processors/normalize.ts` - probeTimeline, needsNormalization, normalizeSource
- `apps/worker/src/scripts/eval-highlights.ts` - offline eval harness

**Create (tests, all in `apps/worker/src/__tests__/`):**
`analyze-config.test.ts`, `sentence-graph.test.ts`, `scan-windows.test.ts`, `candidates.test.ts`, `snap.test.ts`, `language.test.ts`, `gates.test.ts`, `select.test.ts`, `llm.test.ts`, `scanner.test.ts`, `critic.test.ts`, `analyze-v2.test.ts`, `audio-chunks.test.ts`, `normalize.test.ts`, `engine-dispatch.test.ts`

**Modify:**
- `prisma/schema.prisma` + new migration `prisma/migrations/20260714090000_highlight_core_v2/migration.sql`
- `packages/shared/src/types/index.ts` - Highlight extension, TranscriptionResult.language, ClipKind
- `.env.example` - new env block
- `apps/worker/src/processors/analyze.ts` - rename export to `analyzeHighlightsV1` (body verbatim)
- `apps/worker/src/stages/analyze.ts` - engine dispatch, 0-clip DONE path, shadow mode
- `apps/worker/src/stages/types.ts` - allow empty highlights array
- `apps/worker/src/cost-telemetry.ts` - token-based analysis cost
- `apps/worker/src/stages/finalize.ts` - pass token counts
- `apps/worker/src/processors/transcribe.ts` - language capture, chunked path, coverage
- `apps/worker/src/stages/transcribe.ts` - persist language/coverage/partial, read normalized key
- `apps/worker/src/stages/download.ts` - normalization wiring
- `apps/worker/src/stages/render.ts` - normalized key, new Clip fields, render assertions
- `packages/shared/src/services/clip.service.ts` - trim path uses normalized key
- `apps/bot/src/i18n.ts` + `apps/bot/src/handlers.ts` - caption template, 0-clip/low-quality copy, onboarding copy
- `apps/web/components/clip-card.tsx`, `apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx`, `apps/web/components/project-detail.tsx`, `apps/web/hooks/use-clips.ts` - description, badges, empty state

Execution order = task order. Tasks 1-2 are foundations; 3-13 are the engine (pure units first, LLM plumbing after); 14-15 wire the stage; 16-19 pipeline (transcribe/normalize/render); 20-21 consumers; 22 eval; 23 final verification. Each task ends in a commit and a working tree.

---

### Task 1: Prisma schema, migration, shared types, env example

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260714090000_highlight_core_v2/migration.sql`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add enums and fields to `prisma/schema.prisma`**

Add the two enums right after the existing `JobStepStatus` enum block (search for `enum JobStepStatus`), and the fields inside `model Job` (after line `subtitles ... @default(true)`, currently line 289) and `model Clip` (after `subtitleTrack Json?`, currently line 354):

```prisma
enum AnalyzeEngine {
  LEGACY
  RECALL_CRITIC
}

enum NoClipsReason {
  NO_USABLE_SPEECH
  NO_VIABLE_MOMENTS
  PARTIAL_TRANSCRIPT
}
```

Job additions:

```prisma
  language              String?
  languageRaw           String?
  noClipsReason         NoClipsReason?
  normalizedArtifactKey String?
  analyzeEngine         AnalyzeEngine?
  highlightsVersion     Int            @default(1)
  transcriptCoverage    Float?
  transcriptPartial     Boolean        @default(false)
  analysisInputTokens   Int?
  analysisOutputTokens  Int?
```

Clip additions (source-absolute seconds fields use the same timeline convention as `startTime`/`endTime`):

```prisma
  description String?
  score       Float?
  language    String?
  lowQuality  Boolean @default(false)
  hookStart   Float? // source-absolute seconds, same timeline as startTime/endTime
  hookEnd     Float? // source-absolute seconds
  payoffAt    Float? // source-absolute seconds
  clipKind    String? // TS union ClipKind in shared types

  @@index([jobId, score(sort: Desc)])
```

- [ ] **Step 2: Write the migration SQL by hand** (repo convention: hand-timestamped dirs, additive DDL)

Create `prisma/migrations/20260714090000_highlight_core_v2/migration.sql`:

```sql
-- Highlight core V2: engine flags, language, coverage, clip metadata
CREATE TYPE "AnalyzeEngine" AS ENUM ('LEGACY', 'RECALL_CRITIC');
CREATE TYPE "NoClipsReason" AS ENUM ('NO_USABLE_SPEECH', 'NO_VIABLE_MOMENTS', 'PARTIAL_TRANSCRIPT');

ALTER TABLE "jobs"
  ADD COLUMN "language" TEXT,
  ADD COLUMN "languageRaw" TEXT,
  ADD COLUMN "noClipsReason" "NoClipsReason",
  ADD COLUMN "normalizedArtifactKey" TEXT,
  ADD COLUMN "analyzeEngine" "AnalyzeEngine",
  ADD COLUMN "highlightsVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "transcriptCoverage" DOUBLE PRECISION,
  ADD COLUMN "transcriptPartial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "analysisInputTokens" INTEGER,
  ADD COLUMN "analysisOutputTokens" INTEGER;

ALTER TABLE "clips"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "score" DOUBLE PRECISION,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "lowQuality" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hookStart" DOUBLE PRECISION,
  ADD COLUMN "hookEnd" DOUBLE PRECISION,
  ADD COLUMN "payoffAt" DOUBLE PRECISION,
  ADD COLUMN "clipKind" TEXT;

CREATE INDEX "clips_jobId_score_idx" ON "clips"("jobId", "score" DESC);
```

- [ ] **Step 3: Extend shared types**

In `packages/shared/src/types/index.ts` replace the `Highlight` interface (lines 6-18) with:

```ts
export type ClipKind =
  | "reaction"
  | "conflict"
  | "insight"
  | "story"
  | "funny"
  | "reveal"
  | "question"
  | "opinion"
  | "other";

export interface Highlight {
  start: number;
  end: number;
  /**
   * Optional inner anchor - the most engaging core of the clip.
   * The boundary machine never cuts inside [hookStart, hookEnd].
   */
  hookStart?: number;
  hookEnd?: number;
  title: string;
  /** V1 only. Optional so V2 highlights and inline trim highlights typecheck. */
  reason?: string;
  /** V2 fields - all optional so V1 JSON keeps parsing. */
  description?: string;
  score?: number;
  payoffAt?: number;
  language?: string;
  lowQuality?: boolean;
  shortMoment?: boolean;
  kind?: string;
}
```

And replace the `TranscriptionResult` interface (lines 66-69) with:

```ts
export interface TranscriptionResult {
  text: string;
  segments: WhisperSegment[];
  /** ISO-639-1 only (never a raw Whisper name); null/undefined if unmapped. */
  language?: string;
  /** Whisper's raw language name, verbatim (e.g. "russian"). */
  languageRaw?: string;
  /** Source ranges Whisper never heard (failed chunks). Candidates must not cross these. */
  missingRanges?: Array<{ start: number; end: number; reason: string }>;
}
```

- [ ] **Step 4: Add the env block to `.env.example`** (after line 18 `OPENAI_HIGHLIGHTS_MODEL=gpt-4o-mini`)

```bash
# --- Highlight core V2 (Recall-Judge) ---
ANALYZE_ENGINE=legacy            # legacy | recall-critic | shadow
ANALYZE_V2_PCT=0                 # 0..100, hash(jobId) bucketing when engine=legacy
OPENAI_SCAN_MODEL=gpt-4o-mini
OPENAI_CRITIC_MODEL=gpt-5.1
CRITIC_MODEL_FALLBACK=gpt-5-mini
SELECTION_REASONING_EFFORT=low
CLIP_SCORE_THRESHOLD=0.6
WEAK_FALLBACK_MIN_SCORE=0.35
CLIP_SOFT_CAP=12
CLIP_HARD_MIN_SEC=6
CLIP_TARGET_MIN_SEC=8
CLIP_MAX_SEC=90
SCAN_WINDOW_SEC=600
SCAN_OVERLAP_SEC=90
CRITIC_BATCH_SIZE=6
CRITIC_MAX_CANDIDATES=40
PER_WINDOW_MIN_CANDIDATES=2
REGION_MAX_CANDIDATES=6
ANALYZE_MAX_CONCURRENCY=5
MAX_START_EXPANSION_SEC=3
GAP_SENTENCE=0.60
GAP_PHRASE=0.30
NODE_MAX_SEC=12
LEAD_IN_SEC=0.15
TAIL_HOLD_SEC=0.30
PAYOFF_MAX_TAIL_SEC=4
WHISPER_CHUNK_SEC=1200
TRANSCRIPT_MIN_COVERAGE=0.9
```

- [ ] **Step 5: Apply migration and regenerate clients**

```bash
docker compose exec web npx prisma migrate deploy
docker compose exec web npx prisma generate
docker compose exec worker npx prisma generate
docker compose exec bot npx prisma generate
docker compose exec worker npm run build -w @clipclap/shared
```
Expected: migration `20260714090000_highlight_core_v2` applied; all three generates succeed (the bot reads the new Clip fields in Task 20); shared build clean.

- [ ] **Step 6: Typecheck worker + web still pass**

```bash
docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"
```
Expected: PASS (the only Highlight consumers are the worker and `stages/render.ts` inline trim highlight, which now typechecks because `reason` is optional).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260714090000_highlight_core_v2 packages/shared/src/types/index.ts .env.example
git commit -m "feat(core): schema + types + env for highlight V2 (engine flags, language, clip metadata)"
```

---

### Task 2: V2 config loader

**Files:**
- Create: `apps/worker/src/analyze-v2/config.ts`
- Test: `apps/worker/src/__tests__/analyze-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { loadAnalyzeConfig } from "../analyze-v2/config";

describe("loadAnalyzeConfig", () => {
  it("returns spec defaults when env is empty", () => {
    const cfg = loadAnalyzeConfig({});
    expect(cfg.engine).toBe("legacy");
    expect(cfg.scanModel).toBe("gpt-4o-mini");
    expect(cfg.criticModel).toBe("gpt-5.1");
    expect(cfg.scoreThreshold).toBe(0.6);
    expect(cfg.weakFallbackMinScore).toBe(0.35);
    expect(cfg.softCap).toBe(12);
    expect(cfg.hardMinSec).toBe(6);
    expect(cfg.targetMinSec).toBe(8);
    expect(cfg.maxSec).toBe(90);
    expect(cfg.criticBatchSize).toBe(6);
    expect(cfg.v2Pct).toBe(0);
  });

  it("reads overrides and clamps garbage numbers to defaults", () => {
    const cfg = loadAnalyzeConfig({
      ANALYZE_ENGINE: "recall-critic",
      CLIP_SCORE_THRESHOLD: "0.7",
      CLIP_SOFT_CAP: "not-a-number",
    });
    expect(cfg.engine).toBe("recall-critic");
    expect(cfg.scoreThreshold).toBe(0.7);
    expect(cfg.softCap).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/analyze-config.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/config`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/config.ts`**

```ts
export type AnalyzeEngineSetting = "legacy" | "recall-critic" | "shadow";

export interface AnalyzeConfig {
  engine: AnalyzeEngineSetting;
  v2Pct: number;
  scanModel: string;
  criticModel: string;
  criticModelFallback: string;
  reasoningEffort: string;
  scoreThreshold: number;
  weakFallbackMinScore: number;
  softCap: number;
  hardMinSec: number;
  targetMinSec: number;
  maxSec: number;
  scanWindowSec: number;
  scanOverlapSec: number;
  criticBatchSize: number;
  criticMaxCandidates: number;
  perWindowMinCandidates: number;
  regionMaxCandidates: number;
  maxConcurrency: number;
  maxStartExpansionSec: number;
  gapSentence: number;
  gapPhrase: number;
  nodeMaxSec: number;
  leadInSec: number;
  tailHoldSec: number;
  payoffMaxTailSec: number;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadAnalyzeConfig(env: Env = process.env): AnalyzeConfig {
  const engine = env.ANALYZE_ENGINE;
  return {
    engine:
      engine === "recall-critic" || engine === "shadow" ? engine : "legacy",
    v2Pct: Math.min(100, Math.max(0, num(env, "ANALYZE_V2_PCT", 0))),
    scanModel: env.OPENAI_SCAN_MODEL || "gpt-4o-mini",
    criticModel: env.OPENAI_CRITIC_MODEL || "gpt-5.1",
    criticModelFallback: env.CRITIC_MODEL_FALLBACK || "gpt-5-mini",
    reasoningEffort: env.SELECTION_REASONING_EFFORT || "low",
    scoreThreshold: num(env, "CLIP_SCORE_THRESHOLD", 0.6),
    weakFallbackMinScore: num(env, "WEAK_FALLBACK_MIN_SCORE", 0.35),
    softCap: num(env, "CLIP_SOFT_CAP", 12),
    hardMinSec: num(env, "CLIP_HARD_MIN_SEC", 6),
    targetMinSec: num(env, "CLIP_TARGET_MIN_SEC", 8),
    maxSec: num(env, "CLIP_MAX_SEC", 90),
    scanWindowSec: num(env, "SCAN_WINDOW_SEC", 600),
    scanOverlapSec: num(env, "SCAN_OVERLAP_SEC", 90),
    criticBatchSize: num(env, "CRITIC_BATCH_SIZE", 6),
    criticMaxCandidates: num(env, "CRITIC_MAX_CANDIDATES", 40),
    perWindowMinCandidates: num(env, "PER_WINDOW_MIN_CANDIDATES", 2),
    regionMaxCandidates: num(env, "REGION_MAX_CANDIDATES", 6),
    maxConcurrency: num(env, "ANALYZE_MAX_CONCURRENCY", 5),
    maxStartExpansionSec: num(env, "MAX_START_EXPANSION_SEC", 3),
    gapSentence: num(env, "GAP_SENTENCE", 0.6),
    gapPhrase: num(env, "GAP_PHRASE", 0.3),
    nodeMaxSec: num(env, "NODE_MAX_SEC", 12),
    leadInSec: num(env, "LEAD_IN_SEC", 0.15),
    tailHoldSec: num(env, "TAIL_HOLD_SEC", 0.3),
    payoffMaxTailSec: num(env, "PAYOFF_MAX_TAIL_SEC", 4),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/analyze-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/config.ts apps/worker/src/__tests__/analyze-config.test.ts
git commit -m "feat(analyze-v2): env-backed config loader"
```

---

### Task 3: Internal types + sentence graph

**Files:**
- Create: `apps/worker/src/analyze-v2/types.ts`
- Create: `apps/worker/src/analyze-v2/sentence-graph.ts`
- Test: `apps/worker/src/__tests__/sentence-graph.test.ts`

- [ ] **Step 1: Create `apps/worker/src/analyze-v2/types.ts`** (no test - pure declarations used by every later task; keep names EXACTLY as written, later tasks import them)

```ts
import type { Highlight } from "@clipclap/shared";

export interface SentenceNode {
  index: number;
  start: number;
  end: number;
  text: string;
  /** false = opaque: no/unreliable word timings (music, crosstalk). */
  hasWords: boolean;
  /** 0..1 - how strong a boundary the END of this node is. */
  trailingStrength: number;
  /** prev node's trailingStrength; 1.0 for node 0. */
  leadingStrength: number;
}

export interface ScanWindow {
  index: number;
  startNode: number;
  endNode: number; // inclusive
  speechSec: number;
}

export interface ScanCandidate {
  startNode: number;
  endNode: number;
  payoffNode: number;
  interest: number;
  type: string;
  thread?: string;
  windowIndex: number;
}

export interface MergedCandidate extends ScanCandidate {
  id: string; // "c0", "c1", ...
  threadSetupNode?: number;
}

export interface CriticVerdict {
  id: string;
  keep: boolean;
  score: number;
  grounded: boolean;
  selfContained: boolean;
  startNode: number;
  payoffNode: number;
  endNode: number;
  hookStartNode: number;
  hookEndNode: number;
  title: string;
  description: string;
  titleEvidenceNodes: number[];
  descriptionEvidenceNodes: number[];
  language: string;
  /** Set by degraded paths (critic fallback); flows to Clip.lowQuality. */
  lowQuality?: boolean;
  kind?: string;
}

export interface SnappedClip {
  verdict: CriticVerdict;
  startSec: number;
  endSec: number;
  hookStartSec: number;
  hookEndSec: number;
  payoffSec: number;
  shortMoment: boolean;
}

export type DropReason =
  | "no_clean_start"
  | "opaque_end"
  | "opaque_payoff"
  | "invariant_violation"
  | "too_short"
  | "too_long";

export type SnapResult =
  | { ok: true; clip: SnappedClip }
  | { ok: false; reason: DropReason };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export type NoClipsReasonValue =
  | "NO_USABLE_SPEECH"
  | "NO_VIABLE_MOMENTS"
  | "PARTIAL_TRANSCRIPT";

/** Diagnostic fields persisted inside Job.highlights (v2 shape). */
export type V2Highlight = Highlight & {
  _startNode?: number;
  _endNode?: number;
  _titleEvidenceNodes?: number[];
  _descriptionEvidenceNodes?: number[];
  _grounded?: boolean;
};

export interface V2Result {
  highlights: V2Highlight[];
  noClipsReason?: NoClipsReasonValue;
  telemetry: Record<string, unknown>;
  usage: LlmUsage;
}
```

- [ ] **Step 2: Write the failing sentence-graph test**

```ts
import { describe, expect, it } from "vitest";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { WhisperSegment } from "@clipclap/shared";

const cfg = loadAnalyzeConfig({});

function seg(
  start: number,
  end: number,
  words: Array<[string, number, number]>
): WhisperSegment {
  return {
    start,
    end,
    text: words.map(([t]) => t).join(" "),
    words: words.map(([text, s, e]) => ({ text, start: s, end: e })),
  };
}

describe("buildSentenceGraph", () => {
  it("closes a node on terminal punctuation with strength 1.0 and starts the next", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 4, [["Hello", 0, 0.5], ["world.", 0.6, 1.0], ["Next", 1.2, 1.6], ["thought", 1.7, 2.2]])],
      cfg
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].text).toBe("Hello world.");
    expect(nodes[0].trailingStrength).toBe(1.0);
    expect(nodes[0].end).toBe(1.0); // real word offset
    expect(nodes[1].start).toBe(1.2); // real word onset
    expect(nodes[1].leadingStrength).toBe(1.0);
  });

  it("closes a node on a silence gap >= GAP_SENTENCE with strength 0.8", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 5, [["one", 0, 0.4], ["two", 0.5, 0.9], ["three", 2.0, 2.4]])],
      cfg
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].trailingStrength).toBe(0.8);
    expect(nodes[1].start).toBe(2.0);
  });

  it("emits an opaque node for a segment without words", () => {
    const nodes = buildSentenceGraph(
      [{ start: 0, end: 6, text: "[music]" }],
      cfg
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].hasWords).toBe(false);
    expect(nodes[0].trailingStrength).toBe(0.2);
  });

  it("treats non-monotonic word times as opaque", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 4, [["ok", 0, 0.5], ["broken", 0.4, 0.2]])],
      cfg
    );
    expect(nodes.every((n) => n.hasWords === false)).toBe(true);
  });

  it("force-splits nodes longer than NODE_MAX_SEC and indexes monotonically", () => {
    const words: Array<[string, number, number]> = [];
    for (let i = 0; i < 40; i++) words.push([`w${i}`, i * 0.4, i * 0.4 + 0.3]);
    const nodes = buildSentenceGraph([seg(0, 16, words)], cfg);
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((n) => n.end - n.start <= cfg.nodeMaxSec + 0.5)).toBe(true);
    nodes.forEach((n, i) => expect(n.index).toBe(i));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/sentence-graph.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/sentence-graph`.

- [ ] **Step 4: Implement `apps/worker/src/analyze-v2/sentence-graph.ts`**

```ts
import type { WhisperSegment, SubtitleWord } from "@clipclap/shared";
import type { AnalyzeConfig } from "./config";
import type { SentenceNode } from "./types";

const TERMINAL = /[.!?…。！？]$/;
const CLAUSE = /[,;:-]$/;
const MICRO_SEC = 0.4;
const MAX_WORD_SPAN_SEC = 3;

function wordsUnreliable(words: SubtitleWord[]): boolean {
  let prevStart = -Infinity;
  for (const w of words) {
    if (w.end <= w.start) return true;
    if (w.start < prevStart) return true;
    if (w.end - w.start > MAX_WORD_SPAN_SEC) return true;
    prevStart = w.start;
  }
  return false;
}

export function buildSentenceGraph(
  segments: WhisperSegment[],
  cfg: AnalyzeConfig
): SentenceNode[] {
  const raw: Omit<SentenceNode, "index" | "leadingStrength">[] = [];

  for (const seg of segments) {
    const words = seg.words ?? [];
    if (words.length === 0 || wordsUnreliable(words)) {
      raw.push({
        start: seg.start,
        end: seg.end,
        text: seg.text,
        hasWords: false,
        trailingStrength: 0.2,
      });
      continue;
    }

    let current: SubtitleWord[] = [];
    const close = (strength: number) => {
      if (current.length === 0) return;
      raw.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text: current.map((w) => w.text).join(" "),
        hasWords: true,
        trailingStrength: strength,
      });
      current = [];
    };

    for (let i = 0; i < words.length; i++) {
      current.push(words[i]);
      const w = words[i];
      const next = words[i + 1];
      const gap = next ? next.start - w.end : 0;
      const runningLen = w.end - current[0].start;

      if (TERMINAL.test(w.text)) close(1.0);
      else if (next && gap >= cfg.gapSentence) close(0.8);
      else if (CLAUSE.test(w.text) || (next && gap >= cfg.gapPhrase)) close(0.4);
      else if (runningLen >= cfg.nodeMaxSec) close(0.3);
    }
    close(0.8); // segment end is a Whisper boundary
  }

  // micro-merge: fold sub-0.4s fragments forward into the next node
  const merged: typeof raw = [];
  for (let i = 0; i < raw.length; i++) {
    const node = raw[i];
    const next = raw[i + 1];
    if (node.hasWords && next && next.hasWords && node.end - node.start < MICRO_SEC) {
      merged.push({
        start: node.start,
        end: next.end,
        text: `${node.text} ${next.text}`,
        hasWords: true,
        trailingStrength: next.trailingStrength,
      });
      i += 1;
      continue;
    }
    merged.push(node);
  }

  return merged.map((n, index) => ({
    ...n,
    index,
    leadingStrength: index === 0 ? 1.0 : merged[index - 1].trailingStrength,
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/sentence-graph.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/analyze-v2/types.ts apps/worker/src/analyze-v2/sentence-graph.ts apps/worker/src/__tests__/sentence-graph.test.ts
git commit -m "feat(analyze-v2): sentence graph spine + internal types"
```

---

### Task 4: Scan windows

**Files:**
- Create: `apps/worker/src/analyze-v2/windows.ts`
- Test: `apps/worker/src/__tests__/scan-windows.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildScanWindows, renderWindowText } from "../analyze-v2/windows";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCAN_WINDOW_SEC: "60", SCAN_OVERLAP_SEC: "10" });

function makeNodes(count: number, secEach: number): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * secEach,
    end: i * secEach + secEach,
    text: `node ${i}`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

describe("buildScanWindows", () => {
  it("puts a short transcript in a single window", () => {
    const windows = buildScanWindows(makeNodes(5, 5), cfg); // 25s speech
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ index: 0, startNode: 0, endNode: 4 });
  });

  it("splits long transcripts into overlapping windows covering every node", () => {
    const nodes = makeNodes(40, 5); // 200s speech, 60s windows, 10s overlap
    const windows = buildScanWindows(nodes, cfg);
    expect(windows.length).toBeGreaterThan(2);
    expect(windows[0].startNode).toBe(0);
    expect(windows[windows.length - 1].endNode).toBe(39);
    // overlap: each next window starts before the previous ended
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].startNode).toBeLessThanOrEqual(windows[i - 1].endNode);
    }
    // speech-time accounting only counts word-bearing nodes
    expect(windows[0].speechSec).toBeGreaterThanOrEqual(60);
  });

  it("renders window text as #index lines without timestamps", () => {
    const nodes = makeNodes(3, 5);
    const text = renderWindowText(nodes, { index: 0, startNode: 0, endNode: 2, speechSec: 15 });
    expect(text).toBe("#0 node 0\n#1 node 1\n#2 node 2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/scan-windows.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/windows`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/windows.ts`**

```ts
import type { AnalyzeConfig } from "./config";
import type { ScanWindow, SentenceNode } from "./types";

/** Contiguous node slices of ~scanWindowSec speech with ~scanOverlapSec overlap. */
export function buildScanWindows(
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): ScanWindow[] {
  if (nodes.length === 0) return [];

  const windows: ScanWindow[] = [];
  let startIdx = 0;

  while (startIdx < nodes.length) {
    let speechSec = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < nodes.length; i++) {
      endIdx = i;
      if (nodes[i].hasWords) speechSec += nodes[i].end - nodes[i].start;
      if (speechSec >= cfg.scanWindowSec) break;
    }

    windows.push({
      index: windows.length,
      startNode: nodes[startIdx].index,
      endNode: nodes[endIdx].index,
      speechSec,
    });

    if (endIdx >= nodes.length - 1) break;

    // next window starts scanOverlapSec of speech before this one ended
    let overlap = 0;
    let nextStart = endIdx;
    while (nextStart > startIdx && overlap < cfg.scanOverlapSec) {
      if (nodes[nextStart].hasWords)
        overlap += nodes[nextStart].end - nodes[nextStart].start;
      nextStart -= 1;
    }
    startIdx = Math.max(nextStart, startIdx + 1);
  }

  return windows;
}

export function renderWindowText(
  nodes: SentenceNode[],
  window: ScanWindow
): string {
  const lines: string[] = [];
  for (let i = window.startNode; i <= window.endNode; i++) {
    lines.push(`#${nodes[i].index} ${nodes[i].text}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/scan-windows.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/windows.ts apps/worker/src/__tests__/scan-windows.test.ts
git commit -m "feat(analyze-v2): overlapping scan windows over the sentence graph"
```

---

### Task 5: Candidate merge + stratified critic selection

**Files:**
- Create: `apps/worker/src/analyze-v2/candidates.ts`
- Test: `apps/worker/src/__tests__/candidates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { mergeCandidates, selectCriticCandidates } from "../analyze-v2/candidates";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { ScanCandidate, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function nodes(count: number, secEach = 5): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * secEach,
    end: i * secEach + secEach,
    text: `n${i}`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function cand(p: Partial<ScanCandidate>): ScanCandidate {
  return {
    startNode: 0,
    endNode: 2,
    payoffNode: 1,
    interest: 0.5,
    type: "funny",
    windowIndex: 0,
    ...p,
  };
}

describe("mergeCandidates", () => {
  it("unions candidates overlapping more than half of the shorter one", () => {
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 4, payoffNode: 3, interest: 0.5 }),
        cand({ startNode: 2, endNode: 5, payoffNode: 4, interest: 0.8, type: "reveal" }),
      ],
      nodes(10),
      cfg
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      startNode: 0,
      endNode: 5,
      interest: 0.8,
      type: "reveal", // from the higher-interest constituent
    });
    expect(merged[0].id).toBe("c0");
  });

  it("keeps distant candidates separate and collates thread labels", () => {
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 1, payoffNode: 1, thread: "bet" }),
        cand({ startNode: 8, endNode: 9, payoffNode: 9, thread: "bet" }),
      ],
      nodes(10),
      cfg
    );
    expect(merged).toHaveLength(2);
    expect(merged[1].threadSetupNode).toBe(0); // earliest node of the shared thread
  });

  it("splits merged regions longer than ~130s of speech at the strongest payoff", () => {
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 15, payoffNode: 5, interest: 0.9 }),
        cand({ startNode: 10, endNode: 29, payoffNode: 25, interest: 0.6 }),
      ],
      nodes(30, 6), // union would span 30 nodes * 6s = 180s
      cfg
    );
    expect(merged.length).toBe(2);
    expect(merged.every((m) => {
      const span = (m.endNode - m.startNode + 1) * 6;
      return span <= 135;
    })).toBe(true);
  });
});

describe("selectCriticCandidates", () => {
  it("guarantees per-window representation before global interest fill", () => {
    const all = [
      // window 0: two weak candidates
      cand({ startNode: 0, endNode: 1, payoffNode: 1, interest: 0.2, windowIndex: 0 }),
      cand({ startNode: 2, endNode: 3, payoffNode: 3, interest: 0.25, windowIndex: 0 }),
      // window 1: many strong candidates
      ...Array.from({ length: 10 }, (_, i) =>
        cand({ startNode: 20 + i, endNode: 21 + i, payoffNode: 21 + i, interest: 0.9, windowIndex: 1 })
      ),
    ];
    const merged = mergeCandidates(all, nodes(40), { ...cfg, criticMaxCandidates: 6 });
    const selected = selectCriticCandidates(merged, nodes(40), {
      ...cfg,
      criticMaxCandidates: 6,
    }, 10);
    const window0 = selected.filter((c) => c.windowIndex === 0);
    expect(window0.length).toBeGreaterThanOrEqual(2); // quota survived the flood
    expect(selected.length).toBeLessThanOrEqual(6);
  });

  it("blocks extras at K but never evicts per-window quota picks", () => {
    const merged = mergeCandidates(
      Array.from({ length: 50 }, (_, i) =>
        cand({ startNode: i * 2, endNode: i * 2 + 1, payoffNode: i * 2 + 1, interest: 0.5, windowIndex: Math.floor(i / 10) })
      ),
      nodes(120),
      cfg
    );
    // 5 windows x 2 quota = 10 guaranteed; K = clamp(round(10/2), 8, 40) = 8,
    // so extras are blocked entirely but the quota tier stays -> exactly 10
    const selected = selectCriticCandidates(merged, nodes(120), cfg, 10);
    expect(selected.length).toBe(10);
    for (let w = 0; w < 5; w++) {
      expect(selected.filter((c) => c.windowIndex === w)).toHaveLength(2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/candidates.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/candidates`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/candidates.ts`**

```ts
import type { AnalyzeConfig } from "./config";
import type { MergedCandidate, ScanCandidate, SentenceNode } from "./types";

const SPAN_GUARD_SEC = 130;
const REGION_SEC = 600;

function speechSpanSec(c: { startNode: number; endNode: number }, nodes: SentenceNode[]): number {
  let sec = 0;
  for (let i = c.startNode; i <= c.endNode; i++) {
    if (nodes[i]?.hasWords) sec += nodes[i].end - nodes[i].start;
  }
  return sec;
}

function overlapNodes(a: ScanCandidate, b: ScanCandidate): number {
  return Math.max(0, Math.min(a.endNode, b.endNode) - Math.max(a.startNode, b.startNode) + 1);
}

export function mergeCandidates(
  candidates: ScanCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): MergedCandidate[] {
  const maxNode = nodes.length - 1;
  const valid = candidates.filter(
    (c) =>
      Number.isInteger(c.startNode) &&
      Number.isInteger(c.endNode) &&
      c.startNode >= 0 &&
      c.endNode <= maxNode &&
      c.startNode <= c.endNode
  );
  for (const c of valid) {
    if (!Number.isInteger(c.payoffNode) || c.payoffNode < c.startNode || c.payoffNode > c.endNode) {
      c.payoffNode = c.startNode;
    }
    c.interest = Math.min(1, Math.max(0, c.interest));
  }

  const sorted = [...valid].sort((a, b) => a.startNode - b.startNode);
  const merged: ScanCandidate[] = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const shorter = Math.min(prev.endNode - prev.startNode + 1, c.endNode - c.startNode + 1);
      const shouldMerge =
        overlapNodes(prev, c) > shorter * 0.5 ||
        Math.abs(prev.payoffNode - c.payoffNode) <= 1;
      if (shouldMerge) {
        const stronger = c.interest > prev.interest ? c : prev;
        prev.startNode = Math.min(prev.startNode, c.startNode);
        prev.endNode = Math.max(prev.endNode, c.endNode);
        prev.interest = Math.max(prev.interest, c.interest);
        prev.type = stronger.type;
        prev.payoffNode = stronger.payoffNode;
        prev.thread = prev.thread ?? c.thread;
        continue;
      }
    }
    merged.push({ ...c });
  }

  // span guard: split oversized unions at the payoff, keep two tight halves
  const guarded: ScanCandidate[] = [];
  for (const c of merged) {
    if (speechSpanSec(c, nodes) <= SPAN_GUARD_SEC || c.payoffNode <= c.startNode || c.payoffNode >= c.endNode) {
      guarded.push(c);
      continue;
    }
    guarded.push({ ...c, endNode: c.payoffNode });
    guarded.push({ ...c, startNode: c.payoffNode + 1, payoffNode: c.endNode });
  }

  // thread collation: earliest start node per thread label
  const threadSetup = new Map<string, number>();
  for (const c of guarded) {
    if (!c.thread) continue;
    const prev = threadSetup.get(c.thread);
    if (prev === undefined || c.startNode < prev) threadSetup.set(c.thread, c.startNode);
  }

  return guarded.map((c, i) => ({
    ...c,
    id: `c${i}`,
    threadSetupNode: c.thread ? threadSetup.get(c.thread) : undefined,
  }));
}

/** Stratified, coverage-aware pick of at most K candidates for the critic. */
export function selectCriticCandidates(
  merged: MergedCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  sourceMinutes: number
): MergedCandidate[] {
  const K = Math.min(
    cfg.criticMaxCandidates,
    Math.max(8, Math.round(sourceMinutes / 2))
  );

  const byWindow = new Map<number, MergedCandidate[]>();
  for (const c of merged) {
    const list = byWindow.get(c.windowIndex) ?? [];
    list.push(c);
    byWindow.set(c.windowIndex, list);
  }

  const picked = new Set<string>();
  const result: MergedCandidate[] = [];
  const take = (c: MergedCandidate) => {
    if (picked.has(c.id)) return;
    picked.add(c.id);
    result.push(c);
  };

  // guaranteed per-window quota
  for (const list of byWindow.values()) {
    list
      .sort((a, b) => b.interest - a.interest)
      .slice(0, cfg.perWindowMinCandidates)
      .forEach(take);
  }

  // global extras by interest, capped per 10-min region of the payoff
  const regionCount = new Map<number, number>();
  for (const c of result) {
    const region = Math.floor(nodes[c.payoffNode].start / REGION_SEC);
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
  }
  const extras = merged
    .filter((c) => !picked.has(c.id))
    .sort((a, b) => b.interest - a.interest);
  for (const c of extras) {
    if (result.length >= K) break;
    const region = Math.floor(nodes[c.payoffNode].start / REGION_SEC);
    if ((regionCount.get(region) ?? 0) >= cfg.regionMaxCandidates) continue;
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
    take(c);
  }

  // Quota picks are never evicted - coverage beats the cap for the guaranteed
  // tier; extras only ever fill up to K (the loop above stops at K).
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/candidates.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/candidates.ts apps/worker/src/__tests__/candidates.test.ts
git commit -m "feat(analyze-v2): candidate merge, thread collation, stratified critic selection"
```

---

### Task 6: Boundary snapping (snapNodes)

**Files:**
- Create: `apps/worker/src/analyze-v2/snap.ts`
- Test: `apps/worker/src/__tests__/snap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { snapNodes } from "../analyze-v2/snap";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

/** 20 nodes x 2s each, all strong sentence boundaries. */
function strongNodes(): SentenceNode[] {
  return Array.from({ length: 20 }, (_, i) => ({
    index: i,
    start: i * 2,
    end: i * 2 + 1.8,
    text: `sentence ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function verdict(p: Partial<CriticVerdict>): CriticVerdict {
  return {
    id: "c0",
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode: 2,
    payoffNode: 6,
    endNode: 7,
    hookStartNode: 5,
    hookEndNode: 6,
    title: "t",
    description: "d",
    titleEvidenceNodes: [6],
    descriptionEvidenceNodes: [6],
    language: "en",
    ...p,
  };
}

describe("snapNodes", () => {
  it("snaps a clean clip to word edges with lead-in and tail-hold", () => {
    const r = snapNodes(verdict({}), strongNodes(), cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.startSec).toBeCloseTo(4 - cfg.leadInSec, 5);
    expect(r.clip.endSec).toBeCloseTo(15.8 + cfg.tailHoldSec, 5);
    expect(r.clip.payoffSec).toBeCloseTo(13.8, 5);
    expect(r.clip.shortMoment).toBe(false);
  });

  it("accepts a hook that opens the clip exactly (epsilon, not strict <)", () => {
    const r = snapNodes(verdict({ hookStartNode: 2 }), strongNodes(), cfg);
    expect(r.ok).toBe(true);
  });

  it("forces end at or after the payoff", () => {
    const r = snapNodes(verdict({ endNode: 4, payoffNode: 6 }), strongNodes(), cfg);
    if (!r.ok) throw new Error("should not drop");
    expect(r.clip.endSec).toBeGreaterThanOrEqual(13.8);
  });

  it("drops when the start is weak and no strong boundary is within reach", () => {
    const nodes = strongNodes().map((n, i) =>
      i <= 3 ? { ...n, leadingStrength: 0.3, trailingStrength: 0.3 } : n
    );
    const r = snapNodes(verdict({ startNode: 3, hookStartNode: 5 }), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "no_clean_start" });
  });

  it("drops sub-6s clips instead of extending them", () => {
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 5, endNode: 5, hookStartNode: 5, hookEndNode: 5 }),
      strongNodes(),
      cfg
    );
    // single 1.8s node -> too_short (hookEnd==hookStart also violates, either drop is fine)
    expect(r.ok).toBe(false);
  });

  it("flags 6-8s clips as shortMoment without extending", () => {
    // three 2s nodes -> ~6.4s with lead-in/tail-hold
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 7, endNode: 7, hookStartNode: 6, hookEndNode: 7 }),
      strongNodes(),
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.shortMoment).toBe(true);
    expect(r.clip.endSec - r.clip.startSec).toBeLessThan(8);
  });

  it("drops when the payoff node is opaque", () => {
    const nodes = strongNodes().map((n, i) => (i === 6 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "opaque_payoff" });
  });

  it("walks an opaque end back and re-checks payoff containment", () => {
    const nodes = strongNodes().map((n, i) => (i >= 7 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({ endNode: 8 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec).toBeGreaterThanOrEqual(nodes[6].end); // last word-bearing node covers payoff
  });

  it("compresses >90s clips from the start along strong boundaries, keeping the hook", () => {
    const nodes: SentenceNode[] = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      start: i * 2,
      end: i * 2 + 1.9,
      text: `s${i}.`,
      hasWords: true,
      trailingStrength: 1.0,
      leadingStrength: 1.0,
    }));
    const r = snapNodes(
      verdict({ startNode: 0, payoffNode: 55, endNode: 56, hookStartNode: 54, hookEndNode: 55 }),
      nodes,
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec - r.clip.startSec).toBeLessThanOrEqual(90);
    expect(r.clip.startSec).toBeLessThanOrEqual(nodes[54].start);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/snap.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/snap`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/snap.ts`** (this is spec §7 verbatim in code; keep the comments - they encode precedence rules)

```ts
import type { AnalyzeConfig } from "./config";
import type { CriticVerdict, SentenceNode, SnapResult } from "./types";

const EPS = 0.05;
const SENTENCE_SLACK_SEC = 3;
const STRONG = 0.8;

export function snapNodes(
  verdict: CriticVerdict,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): SnapResult {
  const maxIdx = nodes.length - 1;
  const idxOk = (i: number) => Number.isInteger(i) && i >= 0 && i <= maxIdx;
  if (
    !idxOk(verdict.startNode) ||
    !idxOk(verdict.endNode) ||
    !idxOk(verdict.payoffNode) ||
    !idxOk(verdict.hookStartNode) ||
    !idxOk(verdict.hookEndNode)
  ) {
    return { ok: false, reason: "invariant_violation" };
  }

  let s = nodes[verdict.startNode];
  const p = nodes[verdict.payoffNode];
  let e = nodes[verdict.endNode];

  if (!p.hasWords) return { ok: false, reason: "opaque_payoff" };
  if (!s.hasWords && !e.hasWords) return { ok: false, reason: "opaque_end" };

  // 1. clean start - the mid-thought guard the end already has via trailingStrength.
  //    Walk to an earlier node whose leading boundary is strong, adding at most
  //    maxStartExpansionSec of lead-in; no such node -> drop.
  if (s.leadingStrength < STRONG && s.index > 0) {
    let found: SentenceNode | null = null;
    for (let i = s.index - 1; i >= 0; i--) {
      const cand = nodes[i];
      if (s.start - cand.start > cfg.maxStartExpansionSec) break;
      if (cand.hasWords && cand.leadingStrength >= STRONG) {
        found = cand;
        break;
      }
    }
    if (!found) return { ok: false, reason: "no_clean_start" };
    s = found;
  }
  if (!s.hasWords) return { ok: false, reason: "no_clean_start" };

  // 2. payoff containment, then end selection with bounded tail.
  //    Prefer a strong boundary within payoff+4s, then +7s, else end at the payoff.
  if (e.index < p.index) e = p;
  e = pickEnd(nodes, p, cfg.payoffMaxTailSec) ??
      pickEnd(nodes, p, cfg.payoffMaxTailSec + SENTENCE_SLACK_SEC) ??
      p;
  if (!e.hasWords) {
    const walked = lastWordBearingBefore(nodes, e.index);
    if (!walked || walked.index < p.index) return { ok: false, reason: "opaque_end" };
    e = walked;
  }

  // 3. seconds from real node edges
  const prevS = s.index > 0 ? nodes[s.index - 1] : null;
  let startSec = Math.max(prevS ? prevS.end : 0, s.start - cfg.leadInSec);
  const nextE = e.index < maxIdx ? nodes[e.index + 1] : null;
  let endSec = Math.min(e.end + cfg.tailHoldSec, nextE ? nextE.start : e.end + cfg.tailHoldSec);
  endSec = Math.max(endSec, e.end); // tail-hold shrink must never cut the last word

  const hookStartSec = nodes[verdict.hookStartNode].start;
  const hookEndSec = nodes[verdict.hookEndNode].end;

  // 5a. over-length compression BEFORE invariants: pull the start forward along
  //     strong boundaries only, never past the hook; impossible -> drop.
  if (endSec - startSec > cfg.maxSec) {
    let compressed = false;
    for (let i = s.index + 1; i <= verdict.hookStartNode; i++) {
      const cand = nodes[i];
      if (!cand.hasWords || cand.leadingStrength < STRONG) continue;
      const prev = cand.index > 0 ? nodes[cand.index - 1] : null;
      const candidateStart = Math.max(prev ? prev.end : 0, cand.start - cfg.leadInSec);
      if (endSec - candidateStart <= cfg.maxSec) {
        s = cand;
        startSec = candidateStart;
        compressed = true;
        break;
      }
    }
    if (!compressed) return { ok: false, reason: "too_long" };
  }

  // 4. epsilon-tolerant invariants - violation means drop, better lost than broken
  if (
    !(startSec <= hookStartSec + EPS) ||
    !(hookStartSec < hookEndSec) ||
    !(hookEndSec <= endSec + EPS) ||
    !(startSec < p.end && p.end <= endSec + EPS)
  ) {
    return { ok: false, reason: "invariant_violation" };
  }

  const duration = endSec - startSec;
  if (duration < cfg.hardMinSec) return { ok: false, reason: "too_short" };

  return {
    ok: true,
    clip: {
      verdict,
      startSec,
      endSec,
      hookStartSec,
      hookEndSec,
      payoffSec: p.end,
      shortMoment: duration < cfg.targetMinSec,
    },
  };
}

function pickEnd(
  nodes: SentenceNode[],
  payoff: SentenceNode,
  windowSec: number
): SentenceNode | null {
  let best: SentenceNode | null = null;
  for (let i = payoff.index; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.end - payoff.end > windowSec) break;
    if (n.hasWords && n.trailingStrength >= STRONG) {
      if (!best || n.trailingStrength > best.trailingStrength) best = n;
      if (n.trailingStrength >= 1.0) break; // cannot beat a terminal boundary
    }
  }
  return best;
}

function lastWordBearingBefore(
  nodes: SentenceNode[],
  fromIdx: number
): SentenceNode | null {
  for (let i = fromIdx; i >= 0; i--) {
    if (nodes[i].hasWords) return nodes[i];
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/snap.test.ts`
Expected: PASS (9 tests). If the opaque-end walk test fails, check that `pickEnd` skips non-word-bearing nodes (it must - `n.hasWords &&`).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/snap.ts apps/worker/src/__tests__/snap.test.ts
git commit -m "feat(analyze-v2): boundary machine - clean start, payoff containment, duration policy"
```

---

### Task 7: Language helpers + copy gates

**Files:**
- Create: `apps/worker/src/analyze-v2/language.ts`
- Create: `apps/worker/src/analyze-v2/gates.ts`
- Test: `apps/worker/src/__tests__/language.test.ts`
- Test: `apps/worker/src/__tests__/gates.test.ts`

- [ ] **Step 1: Write the failing language test**

```ts
import { describe, expect, it } from "vitest";
import {
  whisperLanguageToIso,
  isoToLanguageName,
  dominantScript,
  scriptMismatch,
} from "../analyze-v2/language";

describe("whisperLanguageToIso", () => {
  it("maps known Whisper language names to ISO-639-1", () => {
    expect(whisperLanguageToIso("russian")).toBe("ru");
    expect(whisperLanguageToIso("English")).toBe("en");
    expect(whisperLanguageToIso("ukrainian")).toBe("uk");
  });
  it("returns null for unknown names (Job.language stays ISO-only)", () => {
    expect(whisperLanguageToIso("klingon")).toBeNull();
  });
});

describe("isoToLanguageName", () => {
  it("round-trips for prompt interpolation", () => {
    expect(isoToLanguageName("ru")).toBe("Russian");
    expect(isoToLanguageName("en")).toBe("English");
    expect(isoToLanguageName("xx")).toBe("the transcript language");
  });
});

describe("script checks", () => {
  it("detects dominant script", () => {
    expect(dominantScript("Привет как дела")).toBe("cyrillic");
    expect(dominantScript("Hello there")).toBe("latin");
    expect(dominantScript("123 !!!")).toBe("none");
  });
  it("flags a Latin title on a Cyrillic clip and passes matching pairs", () => {
    expect(scriptMismatch("He was shocked", "он был в шоке от этого")).toBe(true);
    expect(scriptMismatch("Он был в шоке", "он был в шоке от этого")).toBe(false);
    expect(scriptMismatch("12345", "он был в шоке")).toBe(false); // no detectable script -> no gate
  });
});
```

- [ ] **Step 2: Write the failing gates test**

```ts
import { describe, expect, it } from "vitest";
import { evidenceGate, snippetFallbackCopy, lexicalOverlap } from "../analyze-v2/gates";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

function nodes(): SentenceNode[] {
  return Array.from({ length: 10 }, (_, i) => ({
    index: i,
    start: i * 2,
    end: i * 2 + 1.8,
    text: i === 4 ? "и тут он всё поставил на кон." : `предложение ${i}.`,
    hasWords: i !== 8, // node 8 is opaque
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function verdict(p: Partial<CriticVerdict>): CriticVerdict {
  return {
    id: "c0",
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode: 2,
    payoffNode: 4,
    endNode: 5,
    hookStartNode: 4,
    hookEndNode: 4,
    title: "Он поставил всё на кон",
    description: "Стример рискует всем в одном моменте.",
    titleEvidenceNodes: [4],
    descriptionEvidenceNodes: [4],
    language: "ru",
    ...p,
  };
}

describe("evidenceGate", () => {
  it("passes valid in-range word-bearing evidence", () => {
    expect(evidenceGate(verdict({}), nodes()).ok).toBe(true);
  });
  it("fails when evidence is out of clip range", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [7] }), nodes()).ok).toBe(false);
  });
  it("fails when evidence is empty or points at an opaque node", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [] }), nodes()).ok).toBe(false);
    expect(
      evidenceGate(verdict({ endNode: 9, descriptionEvidenceNodes: [8] }), nodes()).ok
    ).toBe(false);
  });
  it("fails when critic itself says grounded=false or selfContained=false", () => {
    expect(evidenceGate(verdict({ grounded: false }), nodes()).ok).toBe(false);
    expect(evidenceGate(verdict({ selfContained: false }), nodes()).ok).toBe(false);
  });
});

describe("snippetFallbackCopy", () => {
  it("builds grounded copy from the clip's own words in the clip's language", () => {
    const copy = snippetFallbackCopy(nodes(), 4, 5);
    expect(copy.title).toContain("и тут он");
    expect(copy.title.length).toBeLessThanOrEqual(70);
    expect(copy.description.length).toBeGreaterThan(0);
  });
});

describe("lexicalOverlap", () => {
  it("returns a 0..1 telemetry ratio, never used as a gate", () => {
    const ratio = lexicalOverlap("поставил кон", "и тут он всё поставил на кон.");
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/language.test.ts apps/worker/src/__tests__/gates.test.ts`
Expected: FAIL - modules not found.

- [ ] **Step 4: Implement `apps/worker/src/analyze-v2/language.ts`**

```ts
/** Whisper verbose_json returns full English language names ("russian"). */
const NAME_TO_ISO: Record<string, string> = {
  english: "en", russian: "ru", ukrainian: "uk", spanish: "es", french: "fr",
  german: "de", italian: "it", portuguese: "pt", polish: "pl", turkish: "tr",
  dutch: "nl", swedish: "sv", norwegian: "no", danish: "da", finnish: "fi",
  czech: "cs", slovak: "sk", romanian: "ro", bulgarian: "bg", greek: "el",
  hungarian: "hu", serbian: "sr", croatian: "hr", lithuanian: "lt", latvian: "lv",
  estonian: "et", hebrew: "he", arabic: "ar", hindi: "hi", indonesian: "id",
  vietnamese: "vi", thai: "th", chinese: "zh", japanese: "ja", korean: "ko",
  kazakh: "kk", uzbek: "uz", azerbaijani: "az", georgian: "ka", armenian: "hy",
  belarusian: "be",
};

const ISO_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(NAME_TO_ISO).map(([name, iso]) => [
    iso,
    name.charAt(0).toUpperCase() + name.slice(1),
  ])
);

export function whisperLanguageToIso(raw: string): string | null {
  return NAME_TO_ISO[raw.trim().toLowerCase()] ?? null;
}

export function isoToLanguageName(iso: string): string {
  return ISO_TO_NAME[iso] ?? "the transcript language";
}

export type Script = "cyrillic" | "latin" | "cjk" | "arabic" | "none";

export function dominantScript(text: string): Script {
  const counts: Record<Exclude<Script, "none">, number> = {
    cyrillic: (text.match(/[Ѐ-ӿ]/g) ?? []).length,
    latin: (text.match(/[a-zA-Z]/g) ?? []).length,
    cjk: (text.match(/[぀-ヿ一-鿿가-힯]/g) ?? []).length,
    arabic: (text.match(/[؀-ۿ]/g) ?? []).length,
  };
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count >= 3 ? (best as Script) : "none";
}

/** True when copy and clip text carry clearly different scripts. */
export function scriptMismatch(copy: string, clipText: string): boolean {
  const a = dominantScript(copy);
  const b = dominantScript(clipText);
  if (a === "none" || b === "none") return false;
  return a !== b;
}
```

- [ ] **Step 5: Implement `apps/worker/src/analyze-v2/gates.ts`**

```ts
import type { CriticVerdict, SentenceNode } from "./types";

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/** Evidence-node grounding gate (spec §7): replaces lexical word-matching. */
export function evidenceGate(
  verdict: CriticVerdict,
  nodes: SentenceNode[]
): GateResult {
  if (!verdict.grounded) return { ok: false, reason: "critic_ungrounded" };
  if (!verdict.selfContained) return { ok: false, reason: "not_self_contained" };
  for (const [label, evidence] of [
    ["title", verdict.titleEvidenceNodes],
    ["description", verdict.descriptionEvidenceNodes],
  ] as const) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return { ok: false, reason: `${label}_evidence_missing` };
    }
    for (const idx of evidence) {
      const node = nodes[idx];
      if (
        !Number.isInteger(idx) ||
        !node ||
        idx < verdict.startNode ||
        idx > verdict.endNode ||
        !node.hasWords
      ) {
        return { ok: false, reason: `${label}_evidence_invalid` };
      }
    }
  }
  return { ok: true };
}

/** Verbatim-snippet copy - grounded and correctly-languaged by construction. */
export function snippetFallbackCopy(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): { title: string; description: string } {
  const texts: string[] = [];
  for (let i = startNode; i <= endNode && i < nodes.length; i++) {
    if (nodes[i]?.hasWords) texts.push(nodes[i].text);
  }
  const first = texts[0] ?? "";
  const title = first.length <= 70 ? first : first.slice(0, 69).trimEnd() + "…";
  const rest = texts.slice(1).join(" ");
  const description =
    rest.length > 0
      ? rest.length <= 140
        ? rest
        : rest.slice(0, 139).trimEnd() + "…"
      : title;
  return { title, description };
}

/** Telemetry only - penalizes paraphrase and inflected languages, never gates. */
export function lexicalOverlap(copy: string, clipText: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter((w) => w.length > 2);
  const copyWords = norm(copy);
  if (copyWords.length === 0) return 0;
  const clipWords = new Set(norm(clipText));
  const hits = copyWords.filter((w) => clipWords.has(w)).length;
  return hits / copyWords.length;
}
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/language.test.ts apps/worker/src/__tests__/gates.test.ts`
Expected: PASS (language: 5, gates: 6).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/analyze-v2/language.ts apps/worker/src/analyze-v2/gates.ts apps/worker/src/__tests__/language.test.ts apps/worker/src/__tests__/gates.test.ts
git commit -m "feat(analyze-v2): language mapping, script check, evidence gate, snippet fallback"
```

---

### Task 8: Final selection (tiers, NMS, cap)

**Files:**
- Create: `apps/worker/src/analyze-v2/select.ts`
- Test: `apps/worker/src/__tests__/select.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { selectAndOrder } from "../analyze-v2/select";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SnappedClip } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function clip(startSec: number, endSec: number, score: number, extra?: Partial<CriticVerdict>): SnappedClip {
  return {
    verdict: {
      id: `c-${startSec}-${score}`,
      keep: true,
      score,
      grounded: true,
      selfContained: true,
      startNode: 0,
      payoffNode: 1,
      endNode: 2,
      hookStartNode: 0,
      hookEndNode: 1,
      title: "t",
      description: "d",
      titleEvidenceNodes: [1],
      descriptionEvidenceNodes: [1],
      language: "ru",
      ...extra,
    },
    startSec,
    endSec,
    hookStartSec: startSec + 1,
    hookEndSec: startSec + 3,
    payoffSec: endSec - 2,
    shortMoment: false,
  };
}

describe("selectAndOrder", () => {
  it("returns strong-tier clips sorted by score desc, capped at softCap", () => {
    const clips = Array.from({ length: 15 }, (_, i) => clip(i * 100, i * 100 + 30, 0.6 + (i % 10) * 0.04));
    const r = selectAndOrder(clips, cfg);
    expect(r.tier).toBe("strong");
    expect(r.selected.length).toBe(cfg.softCap);
    for (let i = 1; i < r.selected.length; i++) {
      expect(r.selected[i].verdict.score).toBeLessThanOrEqual(r.selected[i - 1].verdict.score!);
    }
  });

  it("falls back to top-2 weak tier above the absolute floor when nothing is strong", () => {
    const clips = [clip(0, 30, 0.5), clip(100, 130, 0.45), clip(200, 230, 0.4)];
    const r = selectAndOrder(clips, cfg);
    expect(r.tier).toBe("weak");
    expect(r.selected).toHaveLength(2);
    expect(r.selected.every((c) => c.verdict.score >= cfg.weakFallbackMinScore)).toBe(true);
  });

  it("returns empty when nothing clears even the weak floor", () => {
    const r = selectAndOrder([clip(0, 30, 0.2)], cfg);
    expect(r.tier).toBe("none");
    expect(r.selected).toHaveLength(0);
  });

  it("NMS is keep-or-drop: the lower-scored clip overlapping >30% of the shorter disappears whole", () => {
    const a = clip(0, 60, 0.9);
    const b = clip(30, 80, 0.7); // 30s overlap of a 50s clip -> 60% of shorter
    const r = selectAndOrder([a, b], cfg);
    expect(r.selected).toHaveLength(1);
    expect(r.selected[0].verdict.score).toBe(0.9);
    // no boundary edits happened
    expect(r.selected[0].startSec).toBe(0);
    expect(r.selected[0].endSec).toBe(60);
  });

  it("keeps small overlaps (<30% of shorter)", () => {
    const a = clip(0, 60, 0.9);
    const b = clip(55, 120, 0.7); // 5s overlap of a 65s clip
    const r = selectAndOrder([a, b], cfg);
    expect(r.selected).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/select.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/select`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/select.ts`**

```ts
import type { AnalyzeConfig } from "./config";
import type { SnappedClip } from "./types";

export interface SelectionResult {
  selected: SnappedClip[];
  tier: "strong" | "weak" | "none";
  droppedByNms: number;
}

/** Spec §11 selection flow steps 9-12. Input clips have already passed
 *  eligibility (keep, grounded, selfContained, valid boundaries, valid copy). */
export function selectAndOrder(
  clips: SnappedClip[],
  cfg: AnalyzeConfig
): SelectionResult {
  const strong = clips.filter((c) => c.verdict.score >= cfg.scoreThreshold);

  let tier: SelectionResult["tier"];
  let pool: SnappedClip[];
  if (strong.length > 0) {
    tier = "strong";
    pool = strong;
  } else {
    const weak = clips
      .filter((c) => c.verdict.score >= cfg.weakFallbackMinScore)
      .sort((a, b) => b.verdict.score - a.verdict.score)
      .slice(0, 2)
      .map((c) => ({ ...c, verdict: { ...c.verdict, lowQuality: true } }));
    tier = weak.length > 0 ? "weak" : "none";
    pool = weak;
  }

  // keep-or-drop NMS by score - never trim, never merge after the critic
  const byScore = [...pool].sort(
    (a, b) => b.verdict.score - a.verdict.score || a.startSec - b.startSec
  );
  const kept: SnappedClip[] = [];
  let droppedByNms = 0;
  for (const c of byScore) {
    const collides = kept.some((k) => {
      const overlap = Math.min(k.endSec, c.endSec) - Math.max(k.startSec, c.startSec);
      if (overlap <= 0) return false;
      const shorter = Math.min(k.endSec - k.startSec, c.endSec - c.startSec);
      return overlap > shorter * 0.3;
    });
    if (collides) {
      droppedByNms += 1;
      continue;
    }
    kept.push(c);
  }

  return { selected: kept.slice(0, cfg.softCap), tier, droppedByNms };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/select.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/select.ts apps/worker/src/__tests__/select.test.ts
git commit -m "feat(analyze-v2): strong/weak tiers, keep-or-drop NMS, score ordering"
```

---

### Task 9: Prompts and JSON schemas

**Files:**
- Create: `apps/worker/src/analyze-v2/prompts.ts`
- Create: `apps/worker/src/analyze-v2/schemas.ts`

No unit test - these are constants; they are exercised by Tasks 11-13 tests. Typecheck is the gate.

- [ ] **Step 1: Create `apps/worker/src/analyze-v2/prompts.ts`**

Copy the SCANNER and CRITIC system prompts **verbatim** from the approved spec `docs/superpowers/specs/2026-07-13-highlight-core-recall-judge-design.md` §6 (they are production-final there, including the `{{LANGUAGE_NAME}}` / `{{LANGUAGE_ISO}}` placeholders) into exported constants, plus the user-prompt builders:

```ts
import type { MergedCandidate, SentenceNode } from "./types";

export const SCANNER_PROMPT = `...spec §6 SCANNER system prompt, verbatim...`;

export const CRITIC_PROMPT_TEMPLATE = `...spec §6 CRITIC system prompt, verbatim...`;

export function criticSystemPrompt(languageIso: string, languageName: string): string {
  return CRITIC_PROMPT_TEMPLATE
    .replaceAll("{{LANGUAGE_NAME}}", languageName)
    .replaceAll("{{LANGUAGE_ISO}}", languageIso);
}

export function scannerUserPrompt(windowText: string): string {
  return `Transcript slice:\n\n${windowText}`;
}

const CONTEXT_BEFORE = 4;
const CONTEXT_AFTER = 8;
const EDGE_WORD_NODES = 2;

/** Candidate block: node lines with times, word-level lines at the edges. */
export function criticCandidateBlock(
  candidate: MergedCandidate,
  nodes: SentenceNode[]
): string {
  const from = Math.max(0, candidate.startNode - CONTEXT_BEFORE);
  const to = Math.min(nodes.length - 1, candidate.endNode + CONTEXT_AFTER);
  const lines: string[] = [
    `CANDIDATE ${candidate.id} (scanner range #${candidate.startNode}-#${candidate.endNode}, payoff #${candidate.payoffNode}, type ${candidate.type})`,
  ];
  if (candidate.thread && candidate.threadSetupNode !== undefined) {
    lines.push(
      `thread: "${candidate.thread}" - set up around node #${candidate.threadSetupNode}`
    );
  }
  for (let i = from; i <= to; i++) {
    const n = nodes[i];
    lines.push(`#${n.index} [${n.start.toFixed(1)}s-${n.end.toFixed(1)}s] ${n.text}`);
  }
  return lines.join("\n");
}

export function criticUserPrompt(
  batch: MergedCandidate[],
  nodes: SentenceNode[]
): string {
  return batch.map((c) => criticCandidateBlock(c, nodes)).join("\n\n---\n\n");
}
```

Note: word-level edge lines (spec: word timings for the first 2 and last 2 nodes) require word data on nodes; `SentenceNode` intentionally does not carry words - the node lines already sit on word edges, and boundary precision is code-owned. `EDGE_WORD_NODES` is declared for the constant's documentary value; do NOT invent a word-line renderer - the node `[start-end]` times at the edges carry the same signal to the critic. Delete the unused constant if the linter complains.

- [ ] **Step 2: Create `apps/worker/src/analyze-v2/schemas.ts`**

```ts
/** OpenAI json_schema strict bodies. Strict mode requires additionalProperties:false
 *  and every property listed in required. */
export const SCANNER_SCHEMA = {
  name: "scan_candidates",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["start_node", "end_node", "payoff_node", "interest", "type", "thread"],
          properties: {
            start_node: { type: "integer" },
            end_node: { type: "integer" },
            payoff_node: { type: "integer" },
            interest: { type: "number" },
            type: {
              type: "string",
              enum: ["reaction", "conflict", "insight", "story", "funny", "reveal", "question", "opinion", "other"],
            },
            thread: { type: ["string", "null"] },
          },
        },
      },
    },
  },
} as const;

export const CRITIC_SCHEMA = {
  name: "critic_verdicts",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id", "keep", "score", "grounded", "self_contained",
            "start_node", "payoff_node", "end_node",
            "hook_start_node", "hook_end_node",
            "title", "description",
            "title_evidence_nodes", "description_evidence_nodes",
            "language",
          ],
          properties: {
            id: { type: "string" },
            keep: { type: "boolean" },
            score: { type: "number" },
            grounded: { type: "boolean" },
            self_contained: { type: "boolean" },
            start_node: { type: "integer" },
            payoff_node: { type: "integer" },
            end_node: { type: "integer" },
            hook_start_node: { type: "integer" },
            hook_end_node: { type: "integer" },
            title: { type: "string" },
            description: { type: "string" },
            title_evidence_nodes: { type: "array", items: { type: "integer" }, maxItems: 3 },
            description_evidence_nodes: { type: "array", items: { type: "integer" }, maxItems: 3 },
            language: { type: "string" },
          },
        },
      },
    },
  },
} as const;

/** Single-candidate copy repair (same stage-2 model, spec §8). */
export const REPAIR_SCHEMA = {
  name: "copy_repair",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
    },
  },
} as const;
```

- [ ] **Step 3: Typecheck**

Run: `docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/analyze-v2/prompts.ts apps/worker/src/analyze-v2/schemas.ts
git commit -m "feat(analyze-v2): production prompts and strict json_schema bodies"
```

---

### Task 10: LLM call wrapper

**Files:**
- Create: `apps/worker/src/analyze-v2/llm.ts`
- Test: `apps/worker/src/__tests__/llm.test.ts`

- [ ] **Step 1: Write the failing test** (mock the OpenAI client - never call the network in tests)

```ts
import { describe, expect, it, vi } from "vitest";
import { callJsonSchema, newUsage } from "../analyze-v2/llm";
import { SCANNER_SCHEMA } from "../analyze-v2/schemas";

function fakeClient(responses: Array<() => any>) {
  let call = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const r = responses[Math.min(call, responses.length - 1)];
          call += 1;
          return r();
        }),
      },
    },
  } as any;
}

const okResponse = (content: unknown) => ({
  choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

describe("callJsonSchema", () => {
  it("parses a completed structured response and accumulates usage", async () => {
    const usage = newUsage();
    const client = fakeClient([() => okResponse({ candidates: [] })]);
    const r = await callJsonSchema(client, usage, {
      model: "gpt-4o-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
    });
    expect(r).toEqual({ ok: true, data: { candidates: [] } });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 20, requests: 1 });
  });

  it("reports truncation distinctly (finish_reason length)", async () => {
    const client = fakeClient([
      () => ({
        choices: [{ message: { content: "{\"cand" }, finish_reason: "length" }],
        usage: { prompt_tokens: 50, completion_tokens: 400 },
      }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.1",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      maxOutputTokens: 400,
    });
    expect(r).toEqual({ ok: false, kind: "truncated" });
  });

  it("reports refusal distinctly", async () => {
    const client = fakeClient([
      () => ({
        choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.1",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
    });
    expect(r).toEqual({ ok: false, kind: "refusal" });
  });

  it("retries once on a transient API error, then reports error", async () => {
    const client = fakeClient([
      () => { throw Object.assign(new Error("boom"), { status: 500 }); },
      () => { throw Object.assign(new Error("boom"), { status: 500 }); },
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-4o-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("error");
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    const client = fakeClient([
      () => { throw Object.assign(new Error("boom"), { status: 429 }); },
      () => okResponse({ candidates: [] }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-4o-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/llm.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/llm`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/llm.ts`**

```ts
import type OpenAI from "openai";
import type { LlmUsage } from "./types";

export type SchemaCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "truncated" | "refusal" | "error"; error?: string };

export interface SchemaCallOptions {
  model: string;
  system: string;
  user: string;
  schema: { name: string; strict: boolean; schema: unknown };
  temperature?: number;
  maxOutputTokens?: number;
  /** Only sent to gpt-5* models. */
  reasoningEffort?: string;
  retryDelayMs?: number;
}

export function newUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, requests: 0 };
}

export async function callJsonSchema<T>(
  client: OpenAI,
  usage: LlmUsage,
  opts: SchemaCallOptions
): Promise<SchemaCallResult<T>> {
  const body = {
    model: opts.model,
    messages: [
      { role: "system" as const, content: opts.system },
      { role: "user" as const, content: opts.user },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: opts.schema as never,
    },
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxOutputTokens !== undefined
      ? { max_completion_tokens: opts.maxOutputTokens }
      : {}),
    ...(opts.reasoningEffort && opts.model.startsWith("gpt-5")
      ? { reasoning_effort: opts.reasoningEffort }
      : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.chat.completions.create(
        body as Parameters<typeof client.chat.completions.create>[0] & {
          reasoning_effort?: string;
        }
      );
      const completion = response as OpenAI.Chat.Completions.ChatCompletion;
      usage.requests += 1;
      usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
      usage.outputTokens += completion.usage?.completion_tokens ?? 0;

      const choice = completion.choices[0];
      if (!choice) return { ok: false, kind: "error", error: "no choices" };
      if (choice.message.refusal) return { ok: false, kind: "refusal" };
      if (choice.finish_reason === "length") return { ok: false, kind: "truncated" };
      const content = choice.message.content;
      if (!content) return { ok: false, kind: "error", error: "empty content" };
      try {
        return { ok: true, data: JSON.parse(content) as T };
      } catch {
        // strict schema makes this near-impossible; treat as truncation-like
        return { ok: false, kind: "truncated" };
      }
    } catch (error) {
      usage.requests += 1;
      if (attempt === 0) {
        await sleep(opts.retryDelayMs ?? 2000);
        continue;
      }
      return {
        ok: false,
        kind: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: false, kind: "error", error: "unreachable" };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/llm.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/llm.ts apps/worker/src/__tests__/llm.test.ts
git commit -m "feat(analyze-v2): strict-schema LLM wrapper with truncation/refusal/retry + usage"
```

---

### Task 11: Scanner runner

**Files:**
- Create: `apps/worker/src/analyze-v2/scanner.ts`
- Test: `apps/worker/src/__tests__/scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { runScanner } from "../analyze-v2/scanner";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCAN_WINDOW_SEC: "60", SCAN_OVERLAP_SEC: "10" });

function nodes(count: number): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text: `n${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function clientReturning(perCall: Array<() => any>) {
  let n = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const f = perCall[Math.min(n, perCall.length - 1)];
          n += 1;
          return f();
        }),
      },
    },
  } as any;
}

const ok = (candidates: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
});

describe("runScanner", () => {
  it("collects candidates across windows and stamps windowIndex", async () => {
    const client = clientReturning([
      () => ok([{ start_node: 0, end_node: 2, payoff_node: 1, interest: 0.7, type: "funny", thread: null }]),
    ]);
    const r = await runScanner(client, newUsage(), nodes(30), cfg);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]).toMatchObject({ startNode: 0, endNode: 2, payoffNode: 1, interest: 0.7, windowIndex: 0 });
    expect(r.telemetry.windowsTotal).toBeGreaterThan(1);
    expect(r.telemetry.windowsFailed).toBe(0);
  });

  it("drops index-invalid rows and clamps interest", async () => {
    const client = clientReturning([
      () => ok([
        { start_node: -5, end_node: 2, payoff_node: 1, interest: 0.5, type: "funny", thread: null },
        { start_node: 0, end_node: 2, payoff_node: 99, interest: 7, type: "funny", thread: null },
      ]),
    ]);
    const r = await runScanner(client, newUsage(), nodes(10), cfg);
    // first row invalid (start_node<0) -> dropped; second row: payoff out of range -> coerced to start
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].payoffNode).toBe(0);
    expect(r.candidates[0].interest).toBe(1);
  });

  it("skips a window whose call fails twice and keeps going", async () => {
    let call = 0;
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            call += 1;
            if (call <= 2) throw Object.assign(new Error("boom"), { status: 500 });
            return ok([{ start_node: 12, end_node: 14, payoff_node: 13, interest: 0.6, type: "story", thread: null }]);
          }),
        },
      },
    } as any;
    const r = await runScanner(client, newUsage(), nodes(30), { ...cfg, maxConcurrency: 1 });
    expect(r.telemetry.windowsFailed).toBe(1);
    expect(r.candidates.length).toBeGreaterThan(0); // later windows survived
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/scanner.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/scanner`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/scanner.ts`**

```ts
import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, mapWithConcurrency } from "./llm";
import { SCANNER_PROMPT, scannerUserPrompt } from "./prompts";
import { SCANNER_SCHEMA } from "./schemas";
import { buildScanWindows, renderWindowText } from "./windows";
import type { LlmUsage, ScanCandidate, SentenceNode } from "./types";

interface ScanRow {
  start_node: number;
  end_node: number;
  payoff_node: number;
  interest: number;
  type: string;
  thread: string | null;
}

export interface ScannerResult {
  candidates: ScanCandidate[];
  telemetry: {
    windowsTotal: number;
    windowsFailed: number;
    candidatesPerWindow: number[];
  };
}

export async function runScanner(
  client: OpenAI,
  usage: LlmUsage,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): Promise<ScannerResult> {
  const windows = buildScanWindows(nodes, cfg);
  const maxNode = nodes.length - 1;
  const candidatesPerWindow: number[] = new Array(windows.length).fill(0);
  let windowsFailed = 0;
  const all: ScanCandidate[] = [];

  await mapWithConcurrency(windows, cfg.maxConcurrency, async (window) => {
    const result = await callJsonSchema<{ candidates: ScanRow[] }>(client, usage, {
      model: cfg.scanModel,
      system: SCANNER_PROMPT,
      user: scannerUserPrompt(renderWindowText(nodes, window)),
      schema: SCANNER_SCHEMA,
      temperature: 0.4,
    });
    if (!result.ok) {
      // callJsonSchema already retried once; a dead window costs recall, never the job
      windowsFailed += 1;
      console.warn(
        `[analyze-v2] scanner window ${window.index} failed: ${"error" in result ? result.error : result.kind}`
      );
      return;
    }
    for (const row of result.data.candidates ?? []) {
      if (
        !Number.isInteger(row.start_node) ||
        !Number.isInteger(row.end_node) ||
        row.start_node < 0 ||
        row.end_node > maxNode ||
        row.start_node > row.end_node
      ) {
        continue;
      }
      const payoff =
        Number.isInteger(row.payoff_node) &&
        row.payoff_node >= row.start_node &&
        row.payoff_node <= row.end_node
          ? row.payoff_node
          : row.start_node;
      all.push({
        startNode: row.start_node,
        endNode: row.end_node,
        payoffNode: payoff,
        interest: Math.min(1, Math.max(0, Number(row.interest) || 0)),
        type: row.type || "other",
        thread: row.thread ?? undefined,
        windowIndex: window.index,
      });
      candidatesPerWindow[window.index] += 1;
    }
  });

  return {
    candidates: all,
    telemetry: {
      windowsTotal: windows.length,
      windowsFailed,
      candidatesPerWindow,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/scanner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/scanner.ts apps/worker/src/__tests__/scanner.test.ts
git commit -m "feat(analyze-v2): recall scanner over windows with skip-on-failure"
```

---

### Task 12: Critic runner (batching, truncation split, model fallback, invariants, repair)

**Files:**
- Create: `apps/worker/src/analyze-v2/critic.ts`
- Test: `apps/worker/src/__tests__/critic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { runCritic, repairCopy, AnalyzeTechnicalError } from "../analyze-v2/critic";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type { MergedCandidate, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ CRITIC_BATCH_SIZE: "2" });

function nodes(count: number): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text: `узел ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function cand(id: string, startNode: number): MergedCandidate {
  return {
    id,
    startNode,
    endNode: startNode + 3,
    payoffNode: startNode + 2,
    interest: 0.6,
    type: "story",
    windowIndex: 0,
  };
}

const verdictRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  keep: true,
  score: 0.8,
  grounded: true,
  self_contained: true,
  start_node: 0,
  payoff_node: 2,
  end_node: 3,
  hook_start_node: 1,
  hook_end_node: 2,
  title: "Заголовок",
  description: "Описание момента.",
  title_evidence_nodes: [2],
  description_evidence_nodes: [2],
  language: "ru",
  ...over,
});

const ok = (results: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ results }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
});

function seqClient(handlers: Array<(body: any) => any>) {
  let n = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async (body: any) => {
          const h = handlers[Math.min(n, handlers.length - 1)];
          n += 1;
          return h(body);
        }),
      },
    },
  } as any;
}

describe("runCritic", () => {
  it("returns camelCase verdicts for every candidate id", async () => {
    const client = seqClient([() => ok([verdictRow("a"), verdictRow("b", { id: "b" })])]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts).toHaveLength(2);
    expect(r.verdicts[0]).toMatchObject({ id: "a", selfContained: true, titleEvidenceNodes: [2] });
  });

  it("drops rows with unknown or duplicate ids (business invariants)", async () => {
    const client = seqClient([
      () => ok([verdictRow("a"), verdictRow("a"), verdictRow("ghost", { id: "ghost" })]),
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", cfg);
    expect(r.verdicts).toHaveLength(1);
    expect(r.telemetry.invariantDrops).toBe(2);
  });

  it("splits the batch on truncation down to singles", async () => {
    const truncated = () => ({
      choices: [{ message: { content: "{" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 512 },
    });
    const client = seqClient([
      truncated,                       // batch of 2 -> truncated
      () => ok([verdictRow("a")]),     // single a
      () => ok([verdictRow("b", { id: "b" })]), // single b
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts).toHaveLength(2);
    expect(r.telemetry.batchSplits).toBe(1);
  });

  it("falls back to the fallback model on persistent API errors", async () => {
    const boom = () => { throw Object.assign(new Error("down"), { status: 500 }); };
    const client = seqClient([
      boom, boom,                      // primary model, retry inside llm.ts
      () => ok([verdictRow("a")]),     // fallback model succeeds
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 });
    expect(r.verdicts).toHaveLength(1);
    expect(r.telemetry.fallbackModelUsed).toBe(true);
  });

  it("throws AnalyzeTechnicalError when both models are down", async () => {
    const boom = () => { throw Object.assign(new Error("down"), { status: 500 }); };
    const client = seqClient([boom]);
    await expect(
      runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 })
    ).rejects.toBeInstanceOf(AnalyzeTechnicalError);
  });
});

describe("repairCopy", () => {
  it("returns repaired title/description", async () => {
    const client = seqClient([
      () => ({
        choices: [{ message: { content: JSON.stringify({ title: "Он рискнул всем", description: "Описание." }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    ]);
    const r = await repairCopy(client, newUsage(), nodes(10), verdictRowToVerdict(), "ru", cfg);
    expect(r).toEqual({ title: "Он рискнул всем", description: "Описание." });
  });
});

function verdictRowToVerdict() {
  return {
    id: "a", keep: true, score: 0.8, grounded: true, selfContained: true,
    startNode: 0, payoffNode: 2, endNode: 3, hookStartNode: 1, hookEndNode: 2,
    title: "Wrong language title", description: "Wrong language description.",
    titleEvidenceNodes: [2], descriptionEvidenceNodes: [2], language: "ru",
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/critic.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/critic`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/critic.ts`**

```ts
import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, mapWithConcurrency } from "./llm";
import { criticSystemPrompt, criticUserPrompt } from "./prompts";
import { CRITIC_SCHEMA, REPAIR_SCHEMA } from "./schemas";
import { isoToLanguageName } from "./language";
import type { CriticVerdict, LlmUsage, MergedCandidate, SentenceNode } from "./types";

const OUTPUT_TOKENS_PER_CANDIDATE = 400;
const CRITIC_CONCURRENCY = 4;

/** Terminal infrastructure failure - the job must fail retryable, never ship unjudged. */
export class AnalyzeTechnicalError extends Error {}

interface CriticRow {
  id: string;
  keep: boolean;
  score: number;
  grounded: boolean;
  self_contained: boolean;
  start_node: number;
  payoff_node: number;
  end_node: number;
  hook_start_node: number;
  hook_end_node: number;
  title: string;
  description: string;
  title_evidence_nodes: number[];
  description_evidence_nodes: number[];
  language: string;
}

export interface CriticRunResult {
  verdicts: CriticVerdict[];
  telemetry: {
    batchSplits: number;
    refusalDrops: number;
    invariantDrops: number;
    fallbackModelUsed: boolean;
  };
}

export async function runCritic(
  client: OpenAI,
  usage: LlmUsage,
  nodes: SentenceNode[],
  candidates: MergedCandidate[],
  languageIso: string,
  cfg: AnalyzeConfig
): Promise<CriticRunResult> {
  const system = criticSystemPrompt(languageIso, isoToLanguageName(languageIso));
  const telemetry = {
    batchSplits: 0,
    refusalDrops: 0,
    invariantDrops: 0,
    fallbackModelUsed: false,
  };

  const batches: MergedCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += cfg.criticBatchSize) {
    batches.push(candidates.slice(i, i + cfg.criticBatchSize));
  }

  const kindById = new Map(candidates.map((c) => [c.id, c.type]));
  const verdicts: CriticVerdict[] = [];

  const callBatch = async (
    batch: MergedCandidate[],
    model: string,
    capMultiplier: number
  ) =>
    callJsonSchema<{ results: CriticRow[] }>(client, usage, {
      model,
      system,
      user: criticUserPrompt(batch, nodes),
      schema: CRITIC_SCHEMA,
      maxOutputTokens: batch.length * OUTPUT_TOKENS_PER_CANDIDATE * capMultiplier,
      reasoningEffort: cfg.reasoningEffort,
    });

  const processBatch = async (batch: MergedCandidate[]): Promise<CriticRow[]> => {
    let result = await callBatch(batch, cfg.criticModel, 1);

    if (!result.ok && result.kind === "truncated") {
      if (batch.length > 1) {
        // split in half and recurse - each half gets its own budget
        telemetry.batchSplits += 1;
        const mid = Math.ceil(batch.length / 2);
        const [a, b] = [batch.slice(0, mid), batch.slice(mid)];
        return [...(await processBatch(a)), ...(await processBatch(b))];
      }
      // single candidate: double the output cap once
      result = await callBatch(batch, cfg.criticModel, 2);
    }

    if (!result.ok && result.kind === "refusal") {
      result = await callBatch(batch, cfg.criticModel, 1);
      if (!result.ok && result.kind === "refusal") {
        telemetry.refusalDrops += batch.length;
        return [];
      }
    }

    if (!result.ok && result.kind === "error") {
      // llm.ts already retried once with backoff; try the fallback model
      telemetry.fallbackModelUsed = true;
      result = await callBatch(batch, cfg.criticModelFallback, 1);
    }

    if (!result.ok) {
      throw new AnalyzeTechnicalError(
        `critic failed for batch [${batch.map((c) => c.id).join(",")}]: ${result.kind}`
      );
    }
    return result.data.results ?? [];
  };

  const rowsPerBatch = await mapWithConcurrency(batches, CRITIC_CONCURRENCY, processBatch);

  // business invariants: every input id at most once, no unknown ids, sane fields
  const seen = new Set<string>();
  const inputIds = new Set(candidates.map((c) => c.id));
  for (const row of rowsPerBatch.flat()) {
    if (!row || typeof row !== "object" || !inputIds.has(row.id) || seen.has(row.id)) {
      telemetry.invariantDrops += 1;
      continue;
    }
    if (
      !Number.isFinite(row.score) ||
      row.score < 0 ||
      row.score > 1 ||
      typeof row.title !== "string" ||
      row.title.trim().length === 0 ||
      typeof row.description !== "string" ||
      row.description.trim().length === 0
    ) {
      telemetry.invariantDrops += 1;
      continue;
    }
    seen.add(row.id);
    verdicts.push({
      id: row.id,
      keep: row.keep,
      score: row.score,
      grounded: row.grounded,
      selfContained: row.self_contained,
      startNode: row.start_node,
      payoffNode: row.payoff_node,
      endNode: row.end_node,
      hookStartNode: row.hook_start_node,
      hookEndNode: row.hook_end_node,
      title: truncateTitle(row.title),
      description: row.description.trim(),
      titleEvidenceNodes: row.title_evidence_nodes ?? [],
      descriptionEvidenceNodes: row.description_evidence_nodes ?? [],
      language: row.language,
      kind: kindById.get(row.id),
    });
  }

  return { verdicts, telemetry };
}

/** One copy-repair retry through the same stage-2 model (spec §8). */
export async function repairCopy(
  client: OpenAI,
  usage: LlmUsage,
  nodes: SentenceNode[],
  verdict: CriticVerdict,
  languageIso: string,
  cfg: AnalyzeConfig
): Promise<{ title: string; description: string } | null> {
  const clipText = nodes
    .slice(verdict.startNode, verdict.endNode + 1)
    .filter((n) => n.hasWords)
    .map((n) => n.text)
    .join(" ");
  const result = await callJsonSchema<{ title: string; description: string }>(client, usage, {
    model: cfg.criticModel,
    system: `Rewrite the clip title and one-sentence description STRICTLY in ${isoToLanguageName(languageIso)} (${languageIso}). Grounded in the clip text only, no hype, title max 70 characters. Output ONLY the JSON object described by the schema.`,
    user: `Clip transcript:\n${clipText}\n\nCurrent (wrong-language) title: ${verdict.title}\nCurrent description: ${verdict.description}`,
    schema: REPAIR_SCHEMA,
    reasoningEffort: cfg.reasoningEffort,
  });
  if (!result.ok) return null;
  return {
    title: truncateTitle(result.data.title),
    description: result.data.description.trim(),
  };
}

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= 70) return trimmed;
  return trimmed.slice(0, 69).trimEnd() + "…";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/critic.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/critic.ts apps/worker/src/__tests__/critic.test.ts
git commit -m "feat(analyze-v2): critic with batch-split, fallback chain, invariants, copy repair"
```

---

### Task 13: Orchestrator (analyzeHighlightsV2)

**Files:**
- Create: `apps/worker/src/analyze-v2/index.ts`
- Test: `apps/worker/src/__tests__/analyze-v2.test.ts`

- [ ] **Step 1: Write the failing test** (end-to-end over the pure pipeline with a mocked client)

```ts
import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

const cfg = loadAnalyzeConfig({});

/** 40 sentences x ~5s with word timings - enough for one window. */
function transcript(): TranscriptionResult {
  const segments: WhisperSegment[] = Array.from({ length: 40 }, (_, i) => {
    const base = i * 5;
    return {
      start: base,
      end: base + 4.5,
      text: `Это предложение номер ${i}.`,
      words: [
        { text: "Это", start: base, end: base + 1 },
        { text: "предложение", start: base + 1.1, end: base + 2.5 },
        { text: "номер", start: base + 2.6, end: base + 3.4 },
        { text: `${i}.`, start: base + 3.5, end: base + 4.5 },
      ],
    };
  });
  return { text: segments.map((s) => s.text).join(" "), segments, language: "ru" };
}

const scanResponse = () => ({
  choices: [{
    message: {
      content: JSON.stringify({
        candidates: [
          { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
        ],
      }),
    },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 100, completion_tokens: 30 },
});

const criticResponse = (score: number) => ({
  choices: [{
    message: {
      content: JSON.stringify({
        results: [{
          id: "c0", keep: true, score, grounded: true, self_contained: true,
          start_node: 10, payoff_node: 13, end_node: 14,
          hook_start_node: 12, hook_end_node: 13,
          title: "Он назвал номер", description: "Спикер называет номер предложения.",
          title_evidence_nodes: [13], description_evidence_nodes: [13],
          language: "ru",
        }],
      }),
    },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 200, completion_tokens: 80 },
});

function client(...responses: any[]) {
  let n = 0;
  return {
    chat: { completions: { create: vi.fn(async () => responses[Math.min(n++, responses.length - 1)]) } },
  } as any;
}

describe("analyzeHighlightsV2", () => {
  it("produces a scored, described highlight from scan + critic", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.85)),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    const h = r.highlights[0];
    expect(h.title).toBe("Он назвал номер");
    expect(h.description).toBe("Спикер называет номер предложения.");
    expect(h.score).toBe(0.85);
    expect(h.language).toBe("ru");
    expect(h.start).toBeLessThan(h.hookStart!);
    expect(h.end).toBeGreaterThanOrEqual(h.payoffAt!);
    expect(r.noClipsReason).toBeUndefined();
    expect(r.usage.requests).toBeGreaterThanOrEqual(2);
  });

  it("degenerate input returns NO_USABLE_SPEECH without any LLM call", async () => {
    const c = client();
    const r = await analyzeHighlightsV2(
      { text: "hi", segments: [{ start: 0, end: 1, text: "hi", words: [{ text: "hi", start: 0, end: 0.5 }] }] },
      { client: c, cfg, transcriptPartial: false }
    );
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(c.chat.completions.create).not.toHaveBeenCalled();
  });

  it("weak video ships top candidates flagged lowQuality", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.45)),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(true);
  });

  it("0 viable moments on a partial transcript reports PARTIAL_TRANSCRIPT", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.1)),
      cfg,
      transcriptPartial: true,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/analyze-v2.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2`.

- [ ] **Step 3: Implement `apps/worker/src/analyze-v2/index.ts`**

```ts
import OpenAI from "openai";
import type { TranscriptionResult } from "@clipclap/shared";
import { loadAnalyzeConfig, type AnalyzeConfig } from "./config";
import { buildSentenceGraph } from "./sentence-graph";
import { runScanner } from "./scanner";
import { mergeCandidates, selectCriticCandidates } from "./candidates";
import { runCritic, repairCopy } from "./critic";
import { snapNodes } from "./snap";
import { evidenceGate, snippetFallbackCopy, lexicalOverlap } from "./gates";
import { scriptMismatch } from "./language";
import { selectAndOrder } from "./select";
import { newUsage } from "./llm";
import type {
  MergedCandidate,
  SentenceNode,
  SnappedClip,
  V2Highlight,
  V2Result,
} from "./types";

const DEGENERATE_MIN_WORDS = 5;
const DEGENERATE_MIN_SPEECH_SEC = 4;
const TINY_MAX_WORDS = 24;

export interface AnalyzeV2Options {
  client?: OpenAI;
  cfg?: AnalyzeConfig;
  transcriptPartial?: boolean;
}

export async function analyzeHighlightsV2(
  transcription: TranscriptionResult,
  options: AnalyzeV2Options = {}
): Promise<V2Result> {
  const cfg = options.cfg ?? loadAnalyzeConfig();
  const client =
    options.client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const usage = newUsage();
  const partial = options.transcriptPartial ?? false;

  const wordCount = transcription.segments.reduce(
    (sum, s) => sum + (s.words?.length ?? 0),
    0
  );
  const nodes = buildSentenceGraph(transcription.segments, cfg);
  const speechSec = nodes
    .filter((n) => n.hasWords)
    .reduce((sum, n) => sum + (n.end - n.start), 0);

  // 0. degenerate guard - zero LLM cost
  if (
    wordCount < DEGENERATE_MIN_WORDS ||
    speechSec < DEGENERATE_MIN_SPEECH_SEC ||
    nodes.every((n) => !n.hasWords)
  ) {
    return {
      highlights: [],
      noClipsReason: "NO_USABLE_SPEECH",
      telemetry: { wordCount, speechSec, path: "degenerate" },
      usage,
    };
  }

  const languageIso = transcription.language ?? "en";
  let candidates: MergedCandidate[];
  let scannerTelemetry: Record<string, unknown> = {};

  if (wordCount <= TINY_MAX_WORDS) {
    // tiny path: the whole transcript is one candidate, no scanner
    candidates = [
      {
        id: "c0",
        startNode: 0,
        endNode: nodes.length - 1,
        payoffNode: nodes.length - 1,
        interest: 0.5,
        type: "other",
        windowIndex: 0,
      },
    ];
    scannerTelemetry = { path: "tiny" };
  } else {
    const scan = await runScanner(client, usage, nodes, cfg);
    const merged = mergeCandidates(scan.candidates, nodes, cfg);
    const sourceMinutes = speechSec / 60;
    candidates = selectCriticCandidates(merged, nodes, cfg, sourceMinutes);
    scannerTelemetry = {
      path: "full",
      ...scan.telemetry,
      rawCandidates: scan.candidates.length,
      mergedCandidates: merged.length,
      criticCandidates: candidates.length,
    };
  }

  // candidates must not span a transcript hole (spec §9) - a clip cut across
  // audio we never heard cannot be verified
  const missingRanges = transcription.missingRanges ?? [];
  if (missingRanges.length > 0) {
    candidates = candidates.filter((c) => {
      const startSec = nodes[c.startNode].start;
      const endSec = nodes[c.endNode].end;
      return !missingRanges.some((r) => startSec < r.end && endSec > r.start);
    });
  }

  if (candidates.length === 0) {
    return {
      highlights: [],
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry: { ...scannerTelemetry, keptVerdicts: 0 },
      usage,
    };
  }

  const critic = await runCritic(client, usage, nodes, candidates, languageIso, cfg);

  // eligibility: keep + evidence gate + snap + copy language
  const eligible: SnappedClip[] = [];
  let evidenceDrops = 0;
  let snapDrops = 0;
  let copyRepairs = 0;
  let snippetFallbacks = 0;

  for (const verdict of critic.verdicts) {
    if (!verdict.keep) continue;
    const gate = evidenceGate(verdict, nodes);
    if (!gate.ok) {
      evidenceDrops += 1;
      continue;
    }
    const snapped = snapNodes(verdict, nodes, cfg);
    if (!snapped.ok) {
      snapDrops += 1;
      continue;
    }

    const clipText = nodes
      .slice(verdict.startNode, verdict.endNode + 1)
      .filter((n) => n.hasWords)
      .map((n) => n.text)
      .join(" ");
    if (scriptMismatch(`${verdict.title} ${verdict.description}`, clipText)) {
      copyRepairs += 1;
      const repaired = await repairCopy(client, usage, nodes, verdict, languageIso, cfg);
      if (repaired && !scriptMismatch(`${repaired.title} ${repaired.description}`, clipText)) {
        verdict.title = repaired.title;
        verdict.description = repaired.description;
      } else {
        snippetFallbacks += 1;
        const snippet = snippetFallbackCopy(nodes, verdict.startNode, verdict.endNode);
        verdict.title = snippet.title;
        verdict.description = snippet.description;
      }
    }
    eligible.push(snapped.clip);
  }

  const selection = selectAndOrder(eligible, cfg);
  const highlights = selection.selected.map(toHighlight);

  const telemetry = {
    ...scannerTelemetry,
    criticVerdicts: critic.verdicts.length,
    ...critic.telemetry,
    evidenceDrops,
    snapDrops,
    copyRepairs,
    snippetFallbacks,
    tier: selection.tier,
    droppedByNms: selection.droppedByNms,
    kept: highlights.length,
    meanLexicalOverlap: mean(
      selection.selected.map((c) =>
        lexicalOverlap(
          c.verdict.title,
          nodes.slice(c.verdict.startNode, c.verdict.endNode + 1).map((n) => n.text).join(" ")
        )
      )
    ),
    durations: highlights.map((h) => Math.round((h.end - h.start) * 10) / 10),
  };

  if (highlights.length === 0) {
    return {
      highlights: [],
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry,
      usage,
    };
  }

  return { highlights, telemetry, usage };
}

function toHighlight(clip: SnappedClip): V2Highlight {
  const v = clip.verdict;
  return {
    start: clip.startSec,
    end: clip.endSec,
    hookStart: clip.hookStartSec,
    hookEnd: clip.hookEndSec,
    payoffAt: clip.payoffSec,
    title: v.title,
    description: v.description,
    score: v.score,
    language: v.language,
    lowQuality: v.lowQuality ?? false,
    shortMoment: clip.shortMoment,
    kind: v.kind,
    _startNode: v.startNode,
    _endNode: v.endNode,
    _titleEvidenceNodes: v.titleEvidenceNodes,
    _descriptionEvidenceNodes: v.descriptionEvidenceNodes,
    _grounded: v.grounded,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}
```

Type note: `SentenceNode` is imported for typing internal helpers only; if the linter flags it as unused, remove the import.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/analyze-v2.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the whole V2 suite together**

Run: `docker compose exec worker npm run test -w @clipclap/worker`
Expected: all worker tests PASS (new + pre-existing `worker-role`, `stage-flow`, `cost-telemetry`).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/analyze-v2/index.ts apps/worker/src/__tests__/analyze-v2.test.ts
git commit -m "feat(analyze-v2): orchestrator - degenerate/tiny paths, gates, repair, selection"
```

---

### Task 14: V1 rename + stage dispatch + 0-clip DONE path

**Files:**
- Modify: `apps/worker/src/processors/analyze.ts` (line 134: export name only)
- Modify: `apps/worker/src/stages/analyze.ts` (full rewrite below)
- Modify: `apps/worker/src/stages/types.ts` (asHighlights: tolerate empty array - it already does; no change needed, verify only)
- Create: `apps/worker/src/analyze-v2/dispatch.ts`
- Test: `apps/worker/src/__tests__/engine-dispatch.test.ts`

- [ ] **Step 1: Rename V1** - in `apps/worker/src/processors/analyze.ts` change only line 134:

```ts
export async function analyzeHighlightsV1(
```

(body stays byte-identical; the kill switch depends on V1 being untouched).

- [ ] **Step 2: Write the failing dispatch test**

```ts
import { describe, expect, it } from "vitest";
import { resolveEngine, jobBucket } from "../analyze-v2/dispatch";

describe("jobBucket", () => {
  it("is deterministic and uniform-ish over 0..99", () => {
    expect(jobBucket("job-abc")).toBe(jobBucket("job-abc"));
    const buckets = new Set(
      Array.from({ length: 200 }, (_, i) => jobBucket(`job-${i}`))
    );
    expect(buckets.size).toBeGreaterThan(50);
    for (const b of buckets) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});

describe("resolveEngine", () => {
  it("honors explicit engine settings", () => {
    expect(resolveEngine("j1", { engine: "recall-critic", v2Pct: 0 })).toBe("recall-critic");
    expect(resolveEngine("j1", { engine: "shadow", v2Pct: 0 })).toBe("shadow");
  });
  it("buckets legacy jobs by pct", () => {
    expect(resolveEngine("j1", { engine: "legacy", v2Pct: 0 })).toBe("legacy");
    expect(resolveEngine("j1", { engine: "legacy", v2Pct: 100 })).toBe("recall-critic");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/engine-dispatch.test.ts`
Expected: FAIL - cannot resolve `../analyze-v2/dispatch`.

- [ ] **Step 4: Implement `apps/worker/src/analyze-v2/dispatch.ts`**

```ts
export type ResolvedEngine = "legacy" | "recall-critic" | "shadow";

/** FNV-1a over the jobId - stable across BullMQ retries and deploys. */
export function jobBucket(jobId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < jobId.length; i++) {
    hash ^= jobId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

export function resolveEngine(
  jobId: string,
  cfg: { engine: "legacy" | "recall-critic" | "shadow"; v2Pct: number }
): ResolvedEngine {
  if (cfg.engine === "recall-critic" || cfg.engine === "shadow") return cfg.engine;
  return jobBucket(jobId) < cfg.v2Pct ? "recall-critic" : "legacy";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/engine-dispatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Rewrite `apps/worker/src/stages/analyze.ts`** (replace the whole file)

```ts
import {
  getStageQueue,
  jobStepService,
  prisma,
} from "@clipclap/shared";
import type { Prisma } from "@prisma/client";
import { analyzeHighlightsV1 } from "../processors/analyze";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { resolveEngine } from "../analyze-v2/dispatch";
import { asTranscription, type AnalyzeStagePayload } from "./types";

export async function runAnalyzeStage(
  payload: AnalyzeStagePayload
): Promise<void> {
  try {
    await jobStepService.startJobStep(payload.jobId, "ANALYZE", payload);
    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "ANALYZING" },
    });

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    const transcription = asTranscription(job.transcriptJson);
    const cfg = loadAnalyzeConfig();
    const engine = resolveEngine(payload.jobId, cfg);

    const startedAt = Date.now();

    if (engine === "legacy" || engine === "shadow") {
      // V1 ships. Shadow additionally runs V2 into JobStep output only.
      const highlights = await analyzeHighlightsV1(transcription);
      const analyzeMs = Date.now() - startedAt;
      await prisma.job.update({
        where: { id: payload.jobId },
        data: {
          status: "ANALYZING",
          highlights: highlights as unknown as Prisma.InputJsonValue,
          analyzeMs,
          analyzeEngine: "LEGACY",
          highlightsVersion: 1,
        },
      });

      let shadow: Prisma.InputJsonValue | undefined;
      if (engine === "shadow") {
        try {
          const v2 = await analyzeHighlightsV2(transcription, {
            cfg,
            transcriptPartial: job.transcriptPartial,
          });
          shadow = {
            highlights: v2.highlights,
            noClipsReason: v2.noClipsReason ?? null,
            telemetry: v2.telemetry,
            usage: v2.usage,
          } as unknown as Prisma.InputJsonValue;
        } catch (error) {
          shadow = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      await jobStepService.completeJobStep(payload.jobId, "ANALYZE", {
        engine,
        highlights: highlights.length,
        analyzeMs,
        ...(shadow !== undefined ? { shadowV2: shadow } : {}),
      });
      await getStageQueue("render").add("render", {
        jobId: payload.jobId,
        userId: payload.userId,
        mode: "clips",
      });
      return;
    }

    // recall-critic path: content outcomes never throw
    const result = await analyzeHighlightsV2(transcription, {
      cfg,
      transcriptPartial: job.transcriptPartial,
    });
    const analyzeMs = Date.now() - startedAt;

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "ANALYZING",
        highlights: result.highlights as unknown as Prisma.InputJsonValue,
        analyzeMs,
        analyzeEngine: "RECALL_CRITIC",
        highlightsVersion: 2,
        noClipsReason: result.noClipsReason ?? null,
        analysisInputTokens: result.usage.inputTokens,
        analysisOutputTokens: result.usage.outputTokens,
      },
    });
    await jobStepService.completeJobStep(payload.jobId, "ANALYZE", {
      engine,
      highlights: result.highlights.length,
      analyzeMs,
      noClipsReason: result.noClipsReason ?? null,
      telemetry: result.telemetry as unknown as Prisma.InputJsonValue,
      usage: result.usage as unknown as Prisma.InputJsonValue,
    });

    if (result.highlights.length === 0) {
      // honest empty outcome: skip render, finalize DONE with the reason
      await getStageQueue("finalize").add("finalize", {
        jobId: payload.jobId,
        userId: payload.userId,
      });
      return;
    }

    await getStageQueue("render").add("render", {
      jobId: payload.jobId,
      userId: payload.userId,
      mode: "clips",
    });
  } catch (error) {
    // technical failures only (LLM outage after fallbacks, DB errors):
    // retryable FAILED, quota untouched, BullMQ retries the stage
    await jobStepService.failJobStep(payload.jobId, "ANALYZE", error);
    await markJobFailed(payload.jobId, error);
    throw error;
  }
}

async function markJobFailed(jobId: string, error: unknown) {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    },
  });
}
```

- [ ] **Step 7: Typecheck + full worker tests**

```bash
docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"
docker compose exec worker npm run test -w @clipclap/worker
```
Expected: PASS. `stage-flow.test.ts` may import `analyzeHighlights` - if it fails on the rename, update its import to `analyzeHighlightsV1` (behavior is unchanged).

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/processors/analyze.ts apps/worker/src/stages/analyze.ts apps/worker/src/analyze-v2/dispatch.ts apps/worker/src/__tests__/engine-dispatch.test.ts
git commit -m "feat(analyze): engine dispatch (legacy/recall-critic/shadow), 0-clip DONE path"
```

---

### Task 15: Token-based analysis cost

**Files:**
- Modify: `apps/worker/src/cost-telemetry.ts`
- Modify: `apps/worker/src/stages/finalize.ts:22-32`
- Modify: `apps/worker/src/__tests__/cost-telemetry.test.ts` (add cases; keep existing ones green)

- [ ] **Step 1: Add failing test cases** to the existing `cost-telemetry.test.ts` describe block:

```ts
  it("uses real token usage for analysis cost when tokens are present", () => {
    const telemetry = buildJobCostTelemetry({
      sourceDurationSec: 3600,
      processingStartedAt: new Date("2026-07-14T10:00:00Z"),
      processingEndedAt: new Date("2026-07-14T10:10:00Z"),
      transcribeMs: 90_000,
      analyzeMs: 20_000,
      renderMs: 420_000,
      clipsGenerated: 8,
      transcriptionModel: "whisper-1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      criticModel: "gpt-5.1",
    });
    // 46000/1M * 1.25 + 11500/1M * 10.0 = 0.0575 + 0.115 = 0.173 -> rounded 0.173
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.173);
  });

  it("falls back to the flat per-minute estimate without token data", () => {
    const telemetry = buildJobCostTelemetry({
      sourceDurationSec: 3600,
      processingStartedAt: new Date("2026-07-14T10:00:00Z"),
      processingEndedAt: new Date("2026-07-14T10:10:00Z"),
      transcribeMs: 90_000,
      analyzeMs: 8_000,
      renderMs: 420_000,
      clipsGenerated: 4,
      transcriptionModel: "whisper-1",
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.003);
  });
```

- [ ] **Step 2: Run to verify the new case fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/cost-telemetry.test.ts`
Expected: FAIL - unknown properties / wrong value.

- [ ] **Step 3: Implement** - in `apps/worker/src/cost-telemetry.ts` add after line 8 (`COMPUTE_COST_PER_MINUTE`):

```ts
/** USD per 1M tokens (input, output). Estimation only - update with pricing. */
const MODEL_TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-5.1": { input: 1.25, output: 10.0 },
};
const DEFAULT_TOKEN_PRICE = { input: 1.25, output: 10.0 };
```

Extend `JobCostTelemetryInput` (after `transcriptionModel?: string;`):

```ts
  analysisInputTokens?: number | null;
  analysisOutputTokens?: number | null;
  /** Model whose price dominates analysis cost (the critic). */
  criticModel?: string;
```

Replace the `estimatedAnalysisCostUsd` computation (lines 30-32) with:

```ts
  const hasTokenUsage =
    (input.analysisInputTokens ?? 0) > 0 || (input.analysisOutputTokens ?? 0) > 0;
  const tokenPrice =
    MODEL_TOKEN_PRICES[input.criticModel ?? ""] ?? DEFAULT_TOKEN_PRICE;
  const estimatedAnalysisCostUsd = hasTokenUsage
    ? roundUsd(
        ((input.analysisInputTokens ?? 0) / 1_000_000) * tokenPrice.input +
          ((input.analysisOutputTokens ?? 0) / 1_000_000) * tokenPrice.output
      )
    : roundUsd(sourceMinutes * ANALYSIS_COST_PER_MINUTE);
```

- [ ] **Step 4: Wire tokens in `apps/worker/src/stages/finalize.ts`** - inside the `buildJobCostTelemetry({...})` call (after `transcriptionModel: ...`):

```ts
          analysisInputTokens: job.analysisInputTokens,
          analysisOutputTokens: job.analysisOutputTokens,
          criticModel: process.env.OPENAI_CRITIC_MODEL || "gpt-5.1",
```

- [ ] **Step 5: Run tests to verify pass**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/cost-telemetry.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/cost-telemetry.ts apps/worker/src/stages/finalize.ts apps/worker/src/__tests__/cost-telemetry.test.ts
git commit -m "feat(telemetry): token-usage-based analysis cost with per-minute fallback"
```

---

### Task 16: Audio chunk planning + transcript stitching

**Files:**
- Create: `apps/worker/src/processors/audio-chunks.ts`
- Test: `apps/worker/src/__tests__/audio-chunks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  parseSilences,
  planChunks,
  stitchTranscripts,
  type RawChunkTranscript,
} from "../processors/audio-chunks";

describe("parseSilences", () => {
  it("parses silencedetect stderr into intervals", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1195.2",
      "[silencedetect @ 0x1] silence_end: 1196.1 | silence_duration: 0.9",
      "[silencedetect @ 0x1] silence_start: 2400.5",
      "[silencedetect @ 0x1] silence_end: 2401.0 | silence_duration: 0.5",
    ].join("\n");
    expect(parseSilences(stderr)).toEqual([
      { start: 1195.2, end: 1196.1 },
      { start: 2400.5, end: 2401.0 },
    ]);
  });
});

describe("planChunks", () => {
  it("returns a single full-range chunk for short audio", () => {
    expect(planChunks(3000, [], 1200, 15, 3)).toEqual([
      { start: 0, end: 3000, overlapStart: null },
    ]);
    // 3000s = 50min < 95min threshold is enforced by the CALLER; planChunks
    // chunks whatever it is given when duration > chunkSec
    expect(planChunks(1000, [], 1200, 15, 3)).toEqual([
      { start: 0, end: 1000, overlapStart: null },
    ]);
  });

  it("snaps chunk boundaries to nearby silence", () => {
    const silences = [{ start: 1195.2, end: 1196.1 }];
    const chunks = planChunks(3000, silences, 1200, 15, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].end).toBeCloseTo(1195.65, 1); // silence midpoint
    expect(chunks[1].start).toBeCloseTo(1195.65, 1);
    expect(chunks[1].overlapStart).toBeNull(); // silence-snapped seam needs no overlap
  });

  it("falls back to a hard cut with overlap when no silence is near", () => {
    const chunks = planChunks(3000, [], 1200, 15, 3);
    expect(chunks[1].start).toBe(1197); // 1200 - 3s overlap
    expect(chunks[1].overlapStart).toBe(1197);
    expect(chunks[0].end).toBe(1200);
  });
});

describe("stitchTranscripts", () => {
  const chunk = (
    offset: number,
    words: Array<[string, number, number]>
  ): RawChunkTranscript => ({
    offsetSec: offset,
    text: words.map(([t]) => t).join(" "),
    segments: [
      {
        start: words[0][1],
        end: words[words.length - 1][2],
        text: words.map(([t]) => t).join(" "),
        words: words.map(([text, start, end]) => ({ text, start, end })),
      },
    ],
  });

  it("re-offsets chunk times into the source timeline", () => {
    const stitched = stitchTranscripts([
      chunk(0, [["a", 0, 1], ["b", 2, 3]]),
      chunk(100, [["c", 0, 1], ["d", 2, 3]]),
    ]);
    const allWords = stitched.segments.flatMap((s) => s.words ?? []);
    expect(allWords.map((w) => w.start)).toEqual([0, 2, 100, 102]);
  });

  it("dedups overlap by matching word sequences, keeping monotonic times", () => {
    // chunk 0 covers 0..12 and ends with "same words here"; chunk 1 starts at 9
    // and begins with the SAME words re-transcribed
    const stitched = stitchTranscripts([
      chunk(0, [["intro", 0, 1], ["same", 9, 10], ["words", 10, 11], ["here", 11, 12]]),
      chunk(9, [["same", 0, 1], ["words", 1, 2], ["here", 2, 3], ["tail", 4, 5]]),
    ]);
    const words = stitched.segments.flatMap((s) => s.words ?? []);
    const texts = words.map((w) => w.text);
    expect(texts.filter((t) => t === "same")).toHaveLength(1); // no duplicate
    for (let i = 1; i < words.length; i++) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
    }
    expect(texts).toContain("intro");
    expect(texts).toContain("tail");
  });

  it("computes coverage from missing ranges", () => {
    const stitched = stitchTranscripts(
      [chunk(0, [["a", 0, 1]]), chunk(200, [["b", 0, 1]])],
      { totalDurationSec: 300, missingRanges: [{ start: 100, end: 200, reason: "chunk_failed" }] }
    );
    expect(stitched.coverage).toBeCloseTo(2 / 3, 2);
    expect(stitched.missingRanges).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/audio-chunks.test.ts`
Expected: FAIL - cannot resolve `../processors/audio-chunks`.

- [ ] **Step 3: Implement `apps/worker/src/processors/audio-chunks.ts`**

```ts
import type { SubtitleWord, WhisperSegment } from "@clipclap/shared";

export interface SilenceInterval {
  start: number;
  end: number;
}

export interface ChunkPlan {
  start: number;
  end: number;
  /** Non-null when the seam is a hard cut: transcription overlap starts here. */
  overlapStart: number | null;
}

export interface RawChunkTranscript {
  offsetSec: number;
  text: string;
  segments: WhisperSegment[];
}

export interface StitchedTranscript {
  text: string;
  segments: WhisperSegment[];
  coverage: number;
  missingRanges: Array<{ start: number; end: number; reason: string }>;
}

export function parseSilences(stderr: string): SilenceInterval[] {
  const result: SilenceInterval[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (endMatch && pendingStart !== null) {
      result.push({ start: pendingStart, end: Number(endMatch[1]) });
      pendingStart = null;
    }
  }
  return result;
}

export function planChunks(
  durationSec: number,
  silences: SilenceInterval[],
  chunkSec: number,
  seekWindowSec: number,
  overlapSec: number
): ChunkPlan[] {
  if (durationSec <= chunkSec) {
    return [{ start: 0, end: durationSec, overlapStart: null }];
  }

  const chunks: ChunkPlan[] = [];
  let cursor = 0;
  let pendingOverlapStart: number | null = null;

  while (cursor < durationSec) {
    const start = cursor;
    const target = start + chunkSec;
    const overlapStart = pendingOverlapStart;
    pendingOverlapStart = null;

    if (target >= durationSec) {
      chunks.push({ start, end: durationSec, overlapStart });
      break;
    }

    const silence = silences
      .map((s) => ({ seam: (s.start + s.end) / 2 }))
      .filter(({ seam }) => Math.abs(seam - target) <= seekWindowSec && seam > start)
      .sort((a, b) => Math.abs(a.seam - target) - Math.abs(b.seam - target))[0];

    if (silence) {
      chunks.push({ start, end: silence.seam, overlapStart });
      cursor = silence.seam;
    } else {
      chunks.push({ start, end: target, overlapStart });
      cursor = target - overlapSec;
      pendingOverlapStart = cursor;
    }
  }
  return chunks;
}
```

And `stitchTranscripts`:

```ts
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function stitchTranscripts(
  chunks: RawChunkTranscript[],
  opts: {
    totalDurationSec?: number;
    missingRanges?: Array<{ start: number; end: number; reason: string }>;
  } = {}
): StitchedTranscript {
  // 1. re-offset every chunk into the source timeline
  const shifted = chunks.map((c) => ({
    ...c,
    segments: c.segments.map((s) => ({
      ...s,
      start: s.start + c.offsetSec,
      end: s.end + c.offsetSec,
      words: s.words?.map((w) => ({
        ...w,
        start: w.start + c.offsetSec,
        end: w.end + c.offsetSec,
      })),
    })),
  }));

  // 2. seam dedup: for each adjacent pair, find the longest common word-token
  //    run inside the time overlap; cut chunk k after the match, chunk k+1 at it
  const result: WhisperSegment[] = [];
  let carry: WhisperSegment[] = shifted[0]?.segments ?? [];

  for (let k = 1; k < shifted.length; k++) {
    const next = shifted[k].segments;
    const overlapStart = shifted[k].segments[0]
      ? shifted[k].offsetSec
      : Infinity;
    const prevTail = carry.filter((s) => s.end > overlapStart);
    const nextHead = next.filter((s) => s.start < (carry[carry.length - 1]?.end ?? -Infinity));

    let seam = overlapStart; // temporal fallback: keep prev before seam, next after
    const prevWords = prevTail.flatMap((s) => s.words ?? []);
    const nextWords = nextHead.flatMap((s) => s.words ?? []);
    const match = longestCommonRun(prevWords, nextWords);
    if (match) {
      // keep the previous chunk's version of the matched run
      seam = match.prevEndTime;
    }

    result.push(...carry.filter((s) => s.start < seam || !prevTail.includes(s)));
    carry = next.filter((s) => s.end > seam);
    // strip words the seam cut through
    carry = carry.map((s) => ({
      ...s,
      words: s.words?.filter((w) => w.start >= seam),
    }));
  }
  result.push(...carry);

  // 3. enforce monotonic word times - violations clamp to the previous edge
  let prevEnd = 0;
  for (const s of result) {
    if (!s.words) continue;
    for (const w of s.words) {
      if (w.start < prevEnd) w.start = prevEnd;
      if (w.end <= w.start) w.end = w.start + 0.05;
      prevEnd = w.end;
    }
  }

  const missingRanges = opts.missingRanges ?? [];
  const total = opts.totalDurationSec ?? Math.max(...result.map((s) => s.end), 0);
  const missing = missingRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const coverage = total > 0 ? Math.max(0, Math.min(1, (total - missing) / total)) : 1;

  return {
    text: result.map((s) => s.text).join(" ").trim(),
    segments: result,
    coverage,
    missingRanges,
  };
}

/** Longest common contiguous normalized-token run (>= 2 tokens) in the overlap. */
function longestCommonRun(
  prevWords: SubtitleWord[],
  nextWords: SubtitleWord[]
): { prevEndTime: number } | null {
  if (prevWords.length === 0 || nextWords.length === 0) return null;
  const a = prevWords.map((w) => norm(w.text));
  const b = nextWords.map((w) => norm(w.text));
  let best = { len: 0, aEnd: -1 };
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== "" && a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best.len) best = { len: dp[i][j], aEnd: i - 1 };
      }
    }
  }
  if (best.len < 2) return null;
  return { prevEndTime: prevWords[best.aEnd].end };
}
```

The file contains: the interfaces, `parseSilences`, `planChunks`, `stitchTranscripts`, and `longestCommonRun` - nothing else.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/audio-chunks.test.ts`
Expected: PASS (6 tests). The seam-dedup test is the tricky one: verify the seam logic keeps the PREVIOUS chunk's matched words and drops the next chunk's re-transcription of them.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/audio-chunks.ts apps/worker/src/__tests__/audio-chunks.test.ts
git commit -m "feat(transcribe): silence parsing, chunk planning, word-aligned transcript stitching"
```

---

### Task 17: Transcribe integration (language, probe, chunked path, coverage)

**Files:**
- Modify: `apps/worker/src/processors/transcribe.ts` (full rewrite below)
- Modify: `apps/worker/src/stages/transcribe.ts:43-54` (persistence)

No new unit test - the pure logic (planning/stitching/language mapping) is covered by Tasks 7 and 16; this task is ffmpeg + Whisper orchestration, verified by typecheck, existing tests, and the Task 23 smoke run. Keep functions small so the eval harness can reuse them.

- [ ] **Step 1: Rewrite `apps/worker/src/processors/transcribe.ts`**

```ts
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createReadStream, statSync } from "fs";
import { unlink } from "fs/promises";
import OpenAI from "openai";
import type {
  SubtitleWord,
  TranscriptionResult,
  WhisperSegment,
} from "@clipclap/shared";
import {
  parseSilences,
  planChunks,
  stitchTranscripts,
  type RawChunkTranscript,
} from "./audio-chunks";
import { whisperLanguageToIso } from "../analyze-v2/language";

const execFileAsync = promisify(execFile);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNK_BYTES_THRESHOLD = 24 * 1024 * 1024; // Whisper hard limit is 25MB
const CHUNK_DURATION_THRESHOLD_SEC = 95 * 60;
const SILENCE_SEEK_WINDOW_SEC = 15;
const HARD_CUT_OVERLAP_SEC = 3;
const PROBE_SEC = 60;

export interface TranscribeOutcome {
  transcription: TranscriptionResult;
  coverage: number;
  partial: boolean;
  missingRanges: Array<{ start: number; end: number; reason: string }>;
}

interface RawWhisperResponse {
  text: string;
  language?: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

export async function transcribeVideo(
  videoPath: string
): Promise<TranscribeOutcome> {
  const audioPath = join(tmpdir(), `clipclap-audio-${randomUUID()}.mp3`);
  const tempFiles: string[] = [audioPath];

  try {
    await execFileAsync("ffmpeg", [
      "-i", videoPath, "-vn", "-acodec", "libmp3lame",
      "-ar", "16000", "-ac", "1", "-b:a", "32k", audioPath, "-y",
    ]);

    const bytes = statSync(audioPath).size;
    const durationSec = await probeDurationSec(audioPath);

    if (bytes <= CHUNK_BYTES_THRESHOLD && durationSec <= CHUNK_DURATION_THRESHOLD_SEC) {
      const raw = await whisperCall(audioPath, undefined);
      return {
        transcription: toTranscription(raw, 0),
        coverage: 1,
        partial: false,
        missingRanges: [],
      };
    }

    // ---- chunked path ----
    const silenceStderr = await runSilenceDetect(audioPath);
    const silences = parseSilences(silenceStderr);
    const chunkSec = Number(process.env.WHISPER_CHUNK_SEC) || 1200;
    const plans = planChunks(
      durationSec, silences, chunkSec, SILENCE_SEEK_WINDOW_SEC, HARD_CUT_OVERLAP_SEC
    );

    // language locked from a speech-rich probe of the beginning (spec §8)
    const language = await probeLanguage(audioPath, silences, tempFiles);

    const rawChunks: RawChunkTranscript[] = [];
    const missingRanges: Array<{ start: number; end: number; reason: string }> = [];

    // sequential-with-small-parallelism: 3 at a time
    for (let i = 0; i < plans.length; i += 3) {
      const batch = plans.slice(i, i + 3);
      const settled = await Promise.allSettled(
        batch.map(async (plan) => {
          const chunkPath = join(tmpdir(), `clipclap-chunk-${randomUUID()}.mp3`);
          tempFiles.push(chunkPath);
          const from = plan.overlapStart ?? plan.start;
          await execFileAsync("ffmpeg", [
            "-ss", String(from), "-to", String(plan.end),
            "-i", audioPath, "-c", "copy", chunkPath, "-y",
          ]);
          // one retry per chunk before declaring the range missing
          let raw: RawWhisperResponse;
          try {
            raw = await whisperCall(chunkPath, language ?? undefined);
          } catch {
            raw = await whisperCall(chunkPath, language ?? undefined);
          }
          return { plan, raw, from };
        })
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === "fulfilled") {
          rawChunks.push({
            offsetSec: s.value.from,
            text: s.value.raw.text,
            segments: toTranscription(s.value.raw, 0).segments,
          });
        } else {
          missingRanges.push({
            start: batch[j].start,
            end: batch[j].end,
            reason: "chunk_failed",
          });
        }
      }
    }

    const stitched = stitchTranscripts(rawChunks, {
      totalDurationSec: durationSec,
      missingRanges,
    });

    const languageRaw = language?.raw;
    return {
      transcription: {
        text: stitched.text,
        segments: stitched.segments,
        language: language?.iso ?? undefined,
        languageRaw,
        // persisted inside transcriptJson so analyze can refuse candidates
        // that would span a hole (spec §9)
        ...(missingRanges.length > 0 ? { missingRanges } : {}),
      },
      coverage: stitched.coverage,
      partial: missingRanges.length > 0,
      missingRanges,
    };
  } finally {
    await Promise.all(tempFiles.map((f) => unlink(f).catch(() => {})));
  }
}

async function whisperCall(
  audioPath: string,
  language?: { iso: string | null; raw: string } | string
): Promise<RawWhisperResponse> {
  const iso = typeof language === "string" ? language : language?.iso;
  const response = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
    ...(iso ? { language: iso } : {}),
  });
  return response as unknown as RawWhisperResponse;
}

/** Single-call path keeps the old word->segment mapping; also captures language. */
function toTranscription(raw: RawWhisperResponse, offset: number): TranscriptionResult {
  const allWords: SubtitleWord[] = (raw.words ?? []).map((w) => ({
    text: w.word.trim(),
    start: w.start + offset,
    end: w.end + offset,
  }));
  const segments: WhisperSegment[] = raw.segments.map((s) => {
    const start = s.start + offset;
    const end = s.end + offset;
    const words = allWords.filter((w) => w.start < end && w.end > start);
    return {
      start,
      end,
      text: s.text.trim(),
      ...(words.length > 0 ? { words } : {}),
    };
  });
  const iso = raw.language ? whisperLanguageToIso(raw.language) : null;
  return {
    text: raw.text,
    segments,
    language: iso ?? undefined,
    languageRaw: raw.language,
  };
}

async function probeDurationSec(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", audioPath,
  ]);
  return Number(stdout.trim()) || 0;
}

async function runSilenceDetect(audioPath: string): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-i", audioPath, "-af", "silencedetect=noise=-30dB:d=0.3",
      "-f", "null", "-",
    ]);
    return stderr ?? "";
  } catch (error) {
    // ffmpeg exits non-zero on some null-muxer paths; stderr still has the data
    const e = error as { stderr?: string };
    return e.stderr ?? "";
  }
}

/** Speech-rich language probe: first 60s of detected speech, not the first 60s. */
async function probeLanguage(
  audioPath: string,
  silences: Array<{ start: number; end: number }>,
  tempFiles: string[]
): Promise<{ iso: string | null; raw: string } | null> {
  // speech starts where the leading silence ends (or at 0)
  const leading = silences.find((s) => s.start <= 0.5);
  const speechStart = leading ? leading.end : 0;
  const probePath = join(tmpdir(), `clipclap-probe-${randomUUID()}.mp3`);
  tempFiles.push(probePath);
  await execFileAsync("ffmpeg", [
    "-ss", String(speechStart), "-t", String(PROBE_SEC),
    "-i", audioPath, "-c", "copy", probePath, "-y",
  ]);
  try {
    const raw = await whisperCall(probePath, undefined);
    if (!raw.language) return null;
    return { iso: whisperLanguageToIso(raw.language), raw: raw.language };
  } catch {
    return null; // probe failure is not fatal - chunks auto-detect
  }
}
```

- [ ] **Step 2: Update the caller `apps/worker/src/stages/transcribe.ts`** - replace lines 37-58 (the transcribe call + `prisma.job.update` + `completeJobStep`) with:

```ts
    const startedAt = Date.now();
    const outcome = await transcribeVideo(localPath);
    const transcribeMs = Date.now() - startedAt;
    const { transcription } = outcome;
    const inferredSourceDurationSec =
      job.sourceDurationSec ?? inferDurationFromSegments(transcription);

    const minCoverage = Number(process.env.TRANSCRIPT_MIN_COVERAGE) || 0.9;
    if (outcome.coverage < minCoverage) {
      throw new Error(
        `Transcript coverage ${(outcome.coverage * 100).toFixed(0)}% is below the ${minCoverage * 100}% floor (${outcome.missingRanges.length} missing ranges)`
      );
    }

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "TRANSCRIBING",
        transcription: transcription.text,
        transcriptJson: transcription as unknown as Prisma.InputJsonValue,
        transcribeMs,
        language: transcription.language ?? null,
        languageRaw: transcription.languageRaw ?? null,
        transcriptCoverage: outcome.coverage,
        transcriptPartial: outcome.partial,
        ...(inferredSourceDurationSec > 0
          ? { sourceDurationSec: inferredSourceDurationSec }
          : {}),
      },
    });
    await jobStepService.completeJobStep(payload.jobId, "TRANSCRIBE", {
      segments: transcription.segments.length,
      transcribeMs,
      language: transcription.language ?? null,
      coverage: outcome.coverage,
      missingRanges: outcome.missingRanges.length,
    });
```

Also change line 35 to read from the normalized artifact when present (Task 18 populates it):

```ts
    const sourceKey = requireString(
      job.normalizedArtifactKey ?? job.sourceArtifactKey,
      "sourceArtifactKey"
    );
    localPath = await downloadVideo(undefined, sourceKey);
```

- [ ] **Step 3: Typecheck + full worker tests**

```bash
docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"
docker compose exec worker npm run test -w @clipclap/worker
```
Expected: PASS. If `stage-flow.test.ts` stubs `transcribeVideo` with the old return shape, update the stub to return `{ transcription, coverage: 1, partial: false, missingRanges: [] }`.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/processors/transcribe.ts apps/worker/src/stages/transcribe.ts
git commit -m "feat(transcribe): language capture + probe, silence-aligned chunking, coverage floor"
```

---

### Task 18: A/V normalization

**Files:**
- Create: `apps/worker/src/processors/normalize.ts`
- Test: `apps/worker/src/__tests__/normalize.test.ts`
- Modify: `apps/worker/src/stages/download.ts:32-41`
- Modify: `packages/shared/src/services/clip.service.ts` (trim enqueue: normalized key)

- [ ] **Step 1: Write the failing test** (pure decision logic only - ffmpeg execution is exercised in the Task 23 smoke)

```ts
import { describe, expect, it } from "vitest";
import { needsNormalization, parseTimelineProbe } from "../processors/normalize";

const probeJson = (videoStart: string, audioStart: string, formatStart = "0.000000") =>
  JSON.stringify({
    format: { start_time: formatStart },
    streams: [
      { index: 0, codec_type: "video", start_time: videoStart },
      { index: 1, codec_type: "audio", start_time: audioStart },
    ],
  });

describe("parseTimelineProbe", () => {
  it("extracts per-stream and format start times", () => {
    const p = parseTimelineProbe(probeJson("0.000000", "0.400000"));
    expect(p.videoStart).toBeCloseTo(0);
    expect(p.audioStart).toBeCloseTo(0.4);
    expect(p.formatStart).toBeCloseTo(0);
    expect(p.hasAudio).toBe(true);
  });
  it("handles N/A start times as unknown", () => {
    const p = parseTimelineProbe(probeJson("N/A", "0.000000"));
    expect(p.videoStart).toBeNull();
  });
  it("handles missing audio stream", () => {
    const p = parseTimelineProbe(
      JSON.stringify({ format: { start_time: "0" }, streams: [{ index: 0, codec_type: "video", start_time: "0" }] })
    );
    expect(p.hasAudio).toBe(false);
    expect(p.hasVideo).toBe(true);
  });
  it("flags audio-only input", () => {
    const p = parseTimelineProbe(
      JSON.stringify({ format: { start_time: "0" }, streams: [{ index: 0, codec_type: "audio", start_time: "0" }] })
    );
    expect(p.hasVideo).toBe(false);
  });
});

describe("needsNormalization", () => {
  it("skips clean files (all starts within 50ms of zero)", () => {
    expect(needsNormalization(parseTimelineProbe(probeJson("0.000000", "0.023000")))).toBe(false);
  });
  it("normalizes when audio and video timelines diverge", () => {
    expect(needsNormalization(parseTimelineProbe(probeJson("0.000000", "0.400000")))).toBe(true);
  });
  it("normalizes when any start time is unknown (N/A)", () => {
    expect(needsNormalization(parseTimelineProbe(probeJson("N/A", "0")))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/normalize.test.ts`
Expected: FAIL - cannot resolve `../processors/normalize`.

- [ ] **Step 3: Implement `apps/worker/src/processors/normalize.ts`**

```ts
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

const START_TOLERANCE_SEC = 0.05;
const SKEW_TOLERANCE_SEC = 0.04;

export interface TimelineProbe {
  formatStart: number | null;
  videoStart: number | null;
  audioStart: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export function parseTimelineProbe(json: string): TimelineProbe {
  const parsed = JSON.parse(json) as {
    format?: { start_time?: string };
    streams?: Array<{ codec_type?: string; start_time?: string }>;
  };
  const toNum = (v: string | undefined): number | null => {
    if (v === undefined || v === "N/A") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  return {
    formatStart: toNum(parsed.format?.start_time),
    videoStart: video ? toNum(video.start_time) : null,
    audioStart: audio ? toNum(audio.start_time) : null,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

export function needsNormalization(probe: TimelineProbe): boolean {
  const starts = [probe.formatStart, probe.videoStart];
  if (probe.hasAudio) starts.push(probe.audioStart);
  // unknown (N/A) start -> cannot trust the timeline, normalize + verify
  if (starts.some((s) => s === null)) return true;
  return starts.some((s) => Math.abs(s as number) > START_TOLERANCE_SEC);
}

export interface NormalizeOutcome {
  path: string;
  action: "none" | "remux" | "reencode";
}

/** Probe -> conditional remux -> verify -> re-encode fallback (spec §10). */
export async function normalizeSource(localPath: string): Promise<NormalizeOutcome> {
  const probe = await probeTimeline(localPath);
  if (!probe.hasVideo) {
    // clear user-facing outcome instead of a confusing downstream failure;
    // a video WITHOUT audio proceeds and ends at the degenerate 0-clip guard
    throw new Error("Audio-only input is not supported - please upload a video file");
  }
  if (!needsNormalization(probe)) {
    return { path: localPath, action: "none" };
  }

  const remuxPath = join(tmpdir(), `clipclap-norm-${randomUUID()}.mp4`);
  try {
    await execFileAsync("ffmpeg", [
      "-ignore_editlist", "1", "-i", localPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero", "-muxpreload", "0", "-muxdelay", "0",
      "-movflags", "+faststart", remuxPath, "-y",
    ]);
    if (await verifyNormalized(remuxPath)) {
      return { path: remuxPath, action: "remux" };
    }
  } catch (error) {
    console.warn("[normalize] remux failed, falling back to re-encode:", error);
  }

  const reencodePath = join(tmpdir(), `clipclap-norm-${randomUUID()}.mp4`);
  await execFileAsync("ffmpeg", [
    "-ignore_editlist", "1", "-i", localPath,
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "160k", "-af", "aresample=async=1",
    "-avoid_negative_ts", "make_zero", "-movflags", "+faststart",
    reencodePath, "-y",
  ]);
  return { path: reencodePath, action: "reencode" };
}

export async function probeTimeline(path: string): Promise<TimelineProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=start_time",
    "-show_entries", "stream=index,codec_type,start_time",
    "-of", "json", path,
  ]);
  return parseTimelineProbe(stdout);
}

async function verifyNormalized(path: string): Promise<boolean> {
  const probe = await probeTimeline(path);
  const near0 = (v: number | null) => v !== null && Math.abs(v) <= START_TOLERANCE_SEC;
  if (!near0(probe.videoStart)) return false;
  if (probe.hasAudio) {
    if (!near0(probe.audioStart)) return false;
    if (
      probe.videoStart !== null &&
      probe.audioStart !== null &&
      Math.abs(probe.videoStart - probe.audioStart) > SKEW_TOLERANCE_SEC
    ) {
      return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec worker npx vitest run --root /app apps/worker/src/__tests__/normalize.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire into `apps/worker/src/stages/download.ts`** - replace lines 32-41 (`sourceArtifactKey` upload + job update + completeJobStep) with:

```ts
    const sourceArtifactKey = `work/${payload.userId}/${payload.jobId}/source-${randomUUID()}.mp4`;
    await uploadFile(sourceArtifactKey, localPath, "video/mp4");

    // A/V timeline normalization (idempotent: BullMQ retries skip when done)
    let normalizedArtifactKey = job.normalizedArtifactKey;
    let normalizeAction = "cached";
    if (!normalizedArtifactKey) {
      const outcome = await normalizeSource(localPath);
      normalizeAction = outcome.action;
      if (outcome.action === "none") {
        normalizedArtifactKey = sourceArtifactKey;
      } else {
        normalizedArtifactKey = `work/${payload.userId}/${payload.jobId}/normalized-${randomUUID()}.mp4`;
        await uploadFile(normalizedArtifactKey, outcome.path, "video/mp4");
        tempNormalizedPath = outcome.path;
      }
    }

    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "DOWNLOADING", sourceArtifactKey, normalizedArtifactKey },
    });
    await jobStepService.completeJobStep(payload.jobId, "DOWNLOAD", {
      sourceArtifactKey,
      normalizedArtifactKey,
      normalizeAction,
    });
```

Add imports and the temp var: `import { normalizeSource } from "../processors/normalize";`, declare `let tempNormalizedPath: string | undefined;` next to `let localPath`, and extend the `finally` block:

```ts
  } finally {
    if (localPath) await unlink(localPath).catch(() => {});
    if (tempNormalizedPath) await unlink(tempNormalizedPath).catch(() => {});
  }
```

- [ ] **Step 6: Trim path reads the normalized artifact** - in `packages/shared/src/services/clip.service.ts`, `editClip` builds the render payload from the parent job. Find the property `sourceArtifactKey` in the enqueued payload (around lines 90-103) and change it to prefer the normalized key:

```ts
        sourceArtifactKey: job.normalizedArtifactKey ?? job.sourceArtifactKey ?? undefined,
```

(where `job` is the parent job already loaded in `editClip`; if only selected fields are fetched, add `normalizedArtifactKey: true` to the select). Then rebuild shared: `docker compose exec worker npm run build -w @clipclap/shared`.

- [ ] **Step 7: Typecheck + tests + commit**

```bash
docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"
docker compose exec worker npm run test -w @clipclap/worker
git add apps/worker/src/processors/normalize.ts apps/worker/src/__tests__/normalize.test.ts apps/worker/src/stages/download.ts packages/shared/src/services/clip.service.ts
git commit -m "feat(download): conditional A/V timeline normalization with verify + re-encode fallback"
```

---

### Task 19: Render - normalized source, new Clip fields, assertions

**Files:**
- Modify: `apps/worker/src/stages/render.ts` (lines 70-78, 110-126, 136-149)

- [ ] **Step 1: Cut from the normalized artifact** - replace lines 70-73:

```ts
    const sourceArtifactKey = requireString(
      job.normalizedArtifactKey ?? job.sourceArtifactKey,
      "sourceArtifactKey"
    );
```

- [ ] **Step 2: Persist the new Clip fields** - replace the `prisma.clip.create` data block (lines 110-123):

```ts
      await prisma.clip.create({
        data: {
          jobId: payload.jobId,
          userId: payload.userId,
          title: highlight.title,
          description: highlight.description ?? null,
          score: highlight.score ?? null,
          language: highlight.language ?? null,
          lowQuality: highlight.lowQuality ?? false,
          hookStart: highlight.hookStart ?? null,
          hookEnd: highlight.hookEnd ?? null,
          payoffAt: highlight.payoffAt ?? null,
          clipKind: highlight.kind ?? null,
          storageKey,
          duration: Math.round(highlight.end - highlight.start),
          startTime: highlight.start,
          endTime: highlight.end,
          subtitles: job.subtitles,
          subtitleTrack: { cues } as unknown as Prisma.InputJsonValue,
          expiresAt: clipExpiresAt,
        },
      });
```

- [ ] **Step 3: Render assertions** - right after the `cutClips` call (after line 105 `tempFiles.push(cutResult.clipPath);`), add:

```ts
      // duration error and A/V start skew are DIFFERENT failures: a clip can
      // have perfect duration and 400ms lip-sync offset (spec §10)
      try {
        const probe = await probeTimeline(cutResult.clipPath);
        const actualDuration = await probeDuration(cutResult.clipPath);
        const renderDurationErrorMs = Math.round(
          Math.abs(actualDuration - (highlight.end - highlight.start)) * 1000
        );
        const renderAvStartSkewMs =
          probe.videoStart !== null && probe.audioStart !== null
            ? Math.round(Math.abs(probe.videoStart - probe.audioStart) * 1000)
            : null;
        renderChecks.push({ renderDurationErrorMs, renderAvStartSkewMs });
        if (renderDurationErrorMs > 500 || (renderAvStartSkewMs ?? 0) > 80) {
          console.warn(
            `[render] drift on job ${payload.jobId}: durationErrorMs=${renderDurationErrorMs} avStartSkewMs=${renderAvStartSkewMs}`
          );
        }
      } catch (error) {
        console.warn(`[render] probe failed for job ${payload.jobId}:`, error);
      }
      // subtitle cue sanity (spec §7): cues must live inside the clip window
      if (cues.length > 0) {
        const clipDuration = highlight.end - highlight.start;
        const last = cues[cues.length - 1];
        if (cues[0].start < 0 || last.end > clipDuration + 0.5) {
          console.warn(
            `[render] cue window violation on job ${payload.jobId}: first=${cues[0].start} last=${last.end} duration=${clipDuration}`
          );
        }
      }
```

Declare `const renderChecks: Array<{ renderDurationErrorMs: number; renderAvStartSkewMs: number | null }> = [];` next to `clipKeys` (line 83), add imports `import { probeTimeline } from "../processors/normalize";`, and add this small helper at the bottom of the file:

```ts
async function probeDuration(path: string): Promise<number> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { stdout } = await promisify(execFile)("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  return Number(stdout.trim()) || 0;
}
```

Include the checks in the render manifest (line 158-162):

```ts
        renderManifest: {
          mode: "clips",
          clipsGenerated,
          clipKeys,
          renderChecks,
        } as Prisma.InputJsonValue,
```

- [ ] **Step 4: Typecheck + tests + commit**

```bash
docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"
docker compose exec worker npm run test -w @clipclap/worker
git add apps/worker/src/stages/render.ts
git commit -m "feat(render): normalized source, V2 clip fields, duration/skew assertions"
```

---

### Task 20: Telegram bot - caption template, 0-clip and low-quality copy

**Files:**
- Create: `packages/shared/src/services/telegram-caption.ts`
- Test: `packages/shared/src/__tests__/telegram-caption.test.ts`
- Modify: `apps/bot/src/i18n.ts` (Dict interface ~lines 42-45, EN block ~121-125, RU block ~235-240, onboarding lines 94 and 207)
- Modify: `apps/bot/src/handlers.ts:350-367`

- [ ] **Step 1: Write the failing caption test** (shared workspace has vitest)

```ts
import { describe, expect, it } from "vitest";
import { buildClipCaption } from "../services/telegram-caption";

describe("buildClipCaption", () => {
  it("joins title and description with a blank line", () => {
    expect(
      buildClipCaption({ title: "Заголовок", description: "Описание момента." })
    ).toBe("Заголовок\n\nОписание момента.");
  });

  it("prepends the low-quality note when flagged", () => {
    const caption = buildClipCaption({
      title: "T",
      description: "D",
      lowQuality: true,
      lowQualityNote: "Внимание: лучшее из доступного.",
    });
    expect(caption.startsWith("Внимание: лучшее из доступного.\n\n")).toBe(true);
  });

  it("clamps to Telegram's 1024-char caption limit", () => {
    const caption = buildClipCaption({
      title: "t".repeat(200),
      description: "d".repeat(2000),
    });
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption.endsWith("…")).toBe(true);
  });

  it("works with title only (legacy clips without description)", () => {
    expect(buildClipCaption({ title: "Only title" })).toBe("Only title");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec worker npx vitest run --root /app packages/shared/src/__tests__/telegram-caption.test.ts`
Expected: FAIL - cannot resolve `../services/telegram-caption`.

- [ ] **Step 3: Implement `packages/shared/src/services/telegram-caption.ts`** and export it from `packages/shared/src/services/index.ts` (add `export * from "./telegram-caption";`)

```ts
const TELEGRAM_CAPTION_MAX = 1024;

export interface ClipCaptionInput {
  title: string;
  description?: string | null;
  lowQuality?: boolean;
  /** Localized note, injected by the bot (i18n lives bot-side). */
  lowQualityNote?: string;
}

/** Plain-text caption (sendVideo uses no parse_mode). ALWAYS clamped to 1024. */
export function buildClipCaption(input: ClipCaptionInput): string {
  const parts: string[] = [];
  if (input.lowQuality && input.lowQualityNote) parts.push(input.lowQualityNote);
  parts.push(input.title);
  if (input.description) parts.push(input.description);
  const caption = parts.join("\n\n").trim();
  if (caption.length <= TELEGRAM_CAPTION_MAX) return caption;
  return caption.slice(0, TELEGRAM_CAPTION_MAX - 1).trimEnd() + "…";
}
```

- [ ] **Step 4: Run test, rebuild shared**

```bash
docker compose exec worker npx vitest run --root /app packages/shared/src/__tests__/telegram-caption.test.ts
docker compose exec worker npm run build -w @clipclap/shared
```
Expected: PASS (4 tests), build clean.

- [ ] **Step 5: Extend `apps/bot/src/i18n.ts`**

Add to the `Dict` interface (next to `done` at ~line 45):

```ts
  doneNoClips: (reason: string) => string;
  lowQualityNote: string;
```

EN block (next to `done` at ~line 125):

```ts
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Done, but I could not find usable speech in this video - no clips this time."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Done, but part of the video could not be processed and no strong moments were found in the rest."
        : "Done. I watched the whole video but did not find moments strong enough for clips - no clips this time. Try a video with more talk, emotion, or story.",
  lowQualityNote: "Heads up: no strong moments found - this is the best available.",
```

RU block (next to `done` at ~line 239):

```ts
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Готово, но в этом видео не нашлось пригодной речи - клипов не будет."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Готово, но часть видео не удалось обработать, а в остальном сильных моментов не нашлось."
        : "Готово. Я просмотрел всё видео, но не нашёл достаточно сильных моментов - клипов в этот раз нет. Попробуй видео с большим количеством речи, эмоций или истории.",
  lowQualityNote: "Внимание: сильных моментов не нашлось - это лучшее из доступного.",
```

Onboarding copy - line 94 (EN), change `3. Get 5-15 short clips back` to:

```
3. Get back the strongest short clips (up to 12 - depends on the video)
```

Line 207 (RU), change `3. Получи 5-15 коротких клипов` to:

```
3. Получи самые сильные короткие клипы (до 12 - зависит от видео)
```

- [ ] **Step 6: Update delivery in `apps/bot/src/handlers.ts`** - replace lines 350-367 (the `done` message + sendVideo loop) with:

```ts
      if (delivery.job.clips.length === 0) {
        await client.sendMessage(
          delivery.chatId,
          dict.doneNoClips(delivery.job.noClipsReason ?? "NO_VIABLE_MOMENTS")
        );
        await markTelegramDeliverySent(delivery.id);
        continue;
      }

      await client.sendMessage(
        delivery.chatId,
        dict.done(delivery.job.clips.length)
      );

      for (const clip of delivery.job.clips) {
        const url = await getPresignedDownloadUrl(clip.storageKey);
        const caption = buildClipCaption({
          title: clip.title,
          description: clip.description,
          lowQuality: clip.lowQuality,
          lowQualityNote: dict.lowQualityNote,
        });
        await client.sendVideo(delivery.chatId, url, caption, {
          inline_keyboard: [
            [
              {
                text: dict.editInBrowserBtn,
                url: `${appUrl}/dashboard/editor?clip=${clip.id}`,
              },
            ],
          ],
        });
      }
```

Add the import at the top of handlers.ts alongside the other `@clipclap/shared` imports: `buildClipCaption`. If `getPendingTelegramDeliveries` selects specific job fields, add `noClipsReason: true` to that select in `packages/shared/src/services/telegram-delivery.service.ts` (if it includes the whole job, nothing to do). Clip ordering: the service orders clips by `startTime asc`; change to `[{ score: "desc" }, { startTime: "asc" }]` in the same service.

- [ ] **Step 7: Verify + commit**

```bash
docker compose exec worker npm run test -w @clipclap/shared
docker compose exec bot sh -c "cd /app/apps/bot && npx tsc --noEmit" || docker compose exec bot sh -c "cd /app/apps/bot && npm run build --if-present"
git add packages/shared/src/services/telegram-caption.ts packages/shared/src/services/index.ts packages/shared/src/__tests__/telegram-caption.test.ts packages/shared/src/services/telegram-delivery.service.ts apps/bot/src/i18n.ts apps/bot/src/handlers.ts
git commit -m "feat(bot): caption with description + 1024 clamp, honest 0-clip copy, onboarding update"
```

---

### Task 21: Web - description, badges, empty state

**Files:**
- Modify: `apps/web/components/clip-card.tsx` (interface lines 14-20, badges 125-132, title block 136-141)
- Modify: `apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx` (header block lines 58-67)
- Modify: `apps/web/components/project-detail.tsx` (clips section lines 183-203 + project prop)

- [ ] **Step 1: `clip-card.tsx`** - extend the interface:

```ts
export interface ClipCardClip {
  id: string;
  title: string;
  duration: number;
  subtitles?: boolean;
  previewUrl?: string | null;
  description?: string | null;
  lowQuality?: boolean;
}
```

Next to the `subtitles` badge (after line 132, inside the same flex container), add:

```tsx
          {clip.lowQuality && (
            <Badge
              variant="outline"
              className="border-yellow-500/40 bg-black/50 px-1.5 py-0 text-[10px] text-yellow-300"
            >
              best available
            </Badge>
          )}
```

Under the title `<p>` (lines 137-140), add the description line:

```tsx
          {clip.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {clip.description}
            </p>
          )}
```

- [ ] **Step 2: `clips/[id]/page.tsx`** - inside the header `<div>` (after the duration/subtitles row, line 66), add:

```tsx
          {clip.description && (
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              {clip.description}
            </p>
          )}
          {clip.lowQuality && (
            <Badge variant="outline" className="mt-2 border-yellow-500/40 text-yellow-300">
              best available
            </Badge>
          )}
```

(`useClip` returns the raw Clip API shape, which now carries `description`/`lowQuality`; if its local TS type is hand-declared in `apps/web/hooks/use-clips.ts`, add the two optional fields there.)

- [ ] **Step 3: `project-detail.tsx`** - empty state. The component's `project` prop is typed inline in this file - add `noClipsReason?: string | null` and `transcriptPartial?: boolean` to that type, and pass both through from the server component that renders `ProjectDetail` (find it with `grep -rn "ProjectDetail" apps/web/app` - add the fields to the object it builds from the Prisma job, which already passes `sourceDurationSec`/`error`).

Replace the clips-grid guard (line 183 `{clips.length > 0 && (`) region: keep the existing grid block unchanged, and add BEFORE it:

```tsx
      {project.status === "DONE" && clips.length === 0 && (
        <div className="rounded-lg border border-border bg-card/40 p-6 text-center">
          <p className="text-sm font-medium">No clips this time</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.noClipsReason === "NO_USABLE_SPEECH"
              ? "We could not find usable speech in this video."
              : project.noClipsReason === "PARTIAL_TRANSCRIPT"
                ? "Part of the video could not be processed, and no strong moments were found in the rest."
                : "We watched the whole video but did not find moments strong enough for clips. Try a video with more talk, emotion, or story."}
          </p>
        </div>
      )}
      {project.transcriptPartial && clips.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Note: part of the video could not be processed; clips come from the rest.
        </p>
      )}
```

Also pass `description` and `lowQuality` into the `ClipCard` clips (the `clips` array this component receives comes from the server page - add both fields where it maps Prisma clips, same place `duration`/`subtitles` are picked).

- [ ] **Step 3b: Order clip lists by quality** - in `packages/shared/src/services/clip.service.ts`, `getClipsByJob` currently orders by `startTime asc` (line ~13). Change to score-first (nulls last keeps legacy clips in their old order):

```ts
    orderBy: [{ score: { sort: "desc", nulls: "last" } }, { startTime: "asc" }],
```

Then rebuild shared: `docker compose exec worker npm run build -w @clipclap/shared`. Add `packages/shared/src/services/clip.service.ts` to the commit in Step 4.

- [ ] **Step 4: Verify + commit**

```bash
docker compose exec web sh -c "cd /app/apps/web && npx tsc --noEmit"
```
Expected: PASS (web is typechecked by Next tooling; if `tsc --noEmit` chokes on Next plugin types, run `docker compose exec web sh -c "cd /app/apps/web && npx next build"` instead and expect a clean build). Then open http://localhost:3000/dashboard and eyeball a project page (old clips render without descriptions - fields are nullable).

```bash
git add apps/web/components/clip-card.tsx "apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx" apps/web/components/project-detail.tsx apps/web/hooks/use-clips.ts
git commit -m "feat(web): clip descriptions, best-available badge, honest empty state"
```

---

### Task 22: Offline eval harness

**Files:**
- Create: `apps/worker/src/scripts/eval-highlights.ts`
- Create: `docs/superpowers/eval/README.md` (manifest format + how to build the labeled set)

- [ ] **Step 1: Create `apps/worker/src/scripts/eval-highlights.ts`**

```ts
/**
 * Offline eval harness for the V2 highlight engine (spec §11 gates).
 *
 * Usage (inside the worker container, needs OPENAI_API_KEY):
 *   npx tsx src/scripts/eval-highlights.ts /app/eval/manifest.json
 *
 * Manifest: JSON array of cases. Each case:
 * {
 *   "id": "podcast-01",
 *   "transcriptJsonFile": "transcripts/podcast-01.json",  // relative to manifest dir; Job.transcriptJson dump
 *   "expected": {
 *     "zeroClips": false,
 *     "language": "ru",
 *     "moments": [{ "start": 125.0, "end": 180.5, "payoffAt": 160.0 }]
 *   }
 * }
 * Dump transcripts with:
 *   npx prisma studio  (copy Job.transcriptJson)  or a psql SELECT into a file.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult } from "@clipclap/shared";

interface EvalMoment { start: number; end: number; payoffAt?: number; }
interface EvalCase {
  id: string;
  transcriptJsonFile: string;
  expected: { zeroClips?: boolean; language?: string; moments: EvalMoment[] };
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("usage: tsx src/scripts/eval-highlights.ts <manifest.json>");
    process.exit(1);
  }
  const cases: EvalCase[] = JSON.parse(readFileSync(manifestPath, "utf8"));
  const baseDir = dirname(manifestPath);
  const cfg = loadAnalyzeConfig();

  let momentsTotal = 0;
  let momentsFound = 0;
  const startErrors: number[] = [];
  const endErrors: number[] = [];
  let payoffContained = 0;
  let payoffTotal = 0;
  let languageWrong = 0;
  let zeroClipFalseNegatives = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const c of cases) {
    const transcription: TranscriptionResult = JSON.parse(
      readFileSync(join(baseDir, c.transcriptJsonFile), "utf8")
    );
    const result = await analyzeHighlightsV2(transcription, { cfg });
    totalInputTokens += result.usage.inputTokens;
    totalOutputTokens += result.usage.outputTokens;

    if (c.expected.zeroClips) {
      if (result.highlights.length > 0) {
        console.log(`[${c.id}] expected 0 clips, got ${result.highlights.length}`);
      }
      continue;
    }
    if (result.highlights.length === 0 && c.expected.moments.length > 0) {
      zeroClipFalseNegatives += 1;
      console.log(`[${c.id}] FALSE NEGATIVE: 0 clips (reason ${result.noClipsReason})`);
    }

    for (const m of c.expected.moments) {
      momentsTotal += 1;
      const hit = result.highlights.find((h) => {
        const overlap = Math.min(h.end, m.end) - Math.max(h.start, m.start);
        return overlap > 0.5 * (m.end - m.start);
      });
      if (!hit) continue;
      momentsFound += 1;
      startErrors.push(Math.abs(hit.start - m.start));
      endErrors.push(Math.abs(hit.end - m.end));
      if (m.payoffAt !== undefined) {
        payoffTotal += 1;
        if (hit.start < m.payoffAt && m.payoffAt <= hit.end) payoffContained += 1;
      }
      if (c.expected.language && hit.language && hit.language !== c.expected.language) {
        languageWrong += 1;
      }
    }
    console.log(
      `[${c.id}] clips=${result.highlights.length} tier-telemetry=${JSON.stringify(result.telemetry["tier"] ?? null)}`
    );
  }

  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
  const quantile = (xs: number[], q: number) => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };

  console.log("\n=== GATES (spec §11) ===");
  console.log(`recall (shipped vs labeled)      ${pct(momentsFound, momentsTotal)}   gate >= 90%`);
  console.log(`median start error               ${quantile(startErrors, 0.5).toFixed(2)}s   gate <= 1.0s`);
  console.log(`median end error                 ${quantile(endErrors, 0.5).toFixed(2)}s   gate <= 1.0s`);
  console.log(`p95 boundary error               ${Math.max(quantile(startErrors, 0.95), quantile(endErrors, 0.95)).toFixed(2)}s   gate <= 3.0s`);
  console.log(`payoff containment               ${pct(payoffContained, payoffTotal)}   gate >= 98%`);
  console.log(`wrong-language copy              ${pct(languageWrong, momentsFound)}   gate <= 1%`);
  console.log(`0-clip false negatives           ${zeroClipFalseNegatives}   gate <= 1`);
  console.log(`tokens: in=${totalInputTokens} out=${totalOutputTokens}`);
  console.log("(precision requires human judgment of shipped clips - review the per-case logs)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Create `docs/superpowers/eval/README.md`**

```markdown
# Highlight V2 offline eval

Gate table lives in the spec (docs/superpowers/specs/2026-07-13-highlight-core-recall-judge-design.md §11).

## Building the labeled set (~80 sources)
25 podcasts, 20 streams, 10 gaming VODs, 10 short/weak videos (expect 0 clips),
10 multilingual/music-heavy, 5 long (2-3h) including yt-dlp merges with known A/V offset.

1. Run each source through the pipeline once (shadow mode is fine) so Job.transcriptJson exists.
2. Dump transcriptJson to eval/transcripts/<id>.json.
3. Watch the source; mark strong moments with acceptable start/end (seconds) and the payoff second.
4. Add a manifest entry (format documented in apps/worker/src/scripts/eval-highlights.ts).

## Running
docker compose exec worker npx tsx src/scripts/eval-highlights.ts /app/eval/manifest.json

Recall here is measured against SHIPPED clips (end-to-end). Scanner-level recall
can be read from the per-job telemetry (JobStep ANALYZE outputJson) in shadow mode.
Precision is human judgment: review shipped clips per case before ramping.
```

- [ ] **Step 3: Typecheck + commit**

```bash
docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"
git add apps/worker/src/scripts/eval-highlights.ts docs/superpowers/eval/README.md
git commit -m "feat(eval): offline gate harness for highlight V2"
```

---

### Task 23: Final verification + shadow smoke

**Files:** none new - verification only.

- [ ] **Step 1: Full test + typecheck sweep**

```bash
docker compose exec worker npm run test -w @clipclap/worker
docker compose exec worker npm run test -w @clipclap/shared
docker compose exec worker sh -c "cd /app/apps/worker && npm run typecheck"
docker compose exec web sh -c "cd /app/apps/web && npx tsc --noEmit"
docker compose exec worker npm run build -w @clipclap/shared
```
Expected: everything green.

- [ ] **Step 2: Shadow smoke on a real video**

1. In `.env` set `ANALYZE_ENGINE=shadow`, then `docker compose up -d` (containers recreate; per project convention re-run `docker compose exec worker npx prisma generate` and `docker compose exec worker npm run build -w @clipclap/shared` afterwards).
2. Upload a short (2-5 min) talky video through the web UI with a test account.
3. Wait for DONE; verify legacy clips shipped as before.
4. Inspect the shadow output: `docker compose exec web npx prisma studio` -> JobStep where step=ANALYZE -> `outputJson.shadowV2` must contain `highlights` with `score`/`description`/`language` and `telemetry`.
5. Check worker logs for scanner/critic warnings: `docker compose logs worker | grep analyze-v2`.
6. Delete the test user's rows afterwards (project convention: test accounts are @test.com / @test.local; never touch real accounts).
7. Revert `.env` to `ANALYZE_ENGINE=legacy` (rollout proceeds later via the eval gate + `ANALYZE_V2_PCT` ramp per spec §11).

- [ ] **Step 3: Use the verify skill** on the full flow (`/verify`) - drive one upload end-to-end and observe: job DONE, clips in dashboard, bot delivery caption format.

- [ ] **Step 4: Final commit if verification produced fixes; otherwise done**

```bash
git status   # expect clean tree
```

---

## Rollout after this plan (operator runbook, no code)

1. Shadow: `ANALYZE_ENGINE=shadow` for a few days; build the eval manifest from shadow jobs (Task 22 README).
2. Run the eval harness; compare against the spec §11 gate table. Tune `CLIP_SCORE_THRESHOLD` / `CRITIC_MAX_CANDIDATES` / models via env only.
3. Gates pass -> `ANALYZE_ENGINE=legacy` + `ANALYZE_V2_PCT=5` -> watch telemetry (JobStep ANALYZE outputJson; retrim rate per Job.analyzeEngine) -> 25 -> 100.
4. Kill switch at any point: `ANALYZE_V2_PCT=0` (or `ANALYZE_ENGINE=legacy`). Zero deploy.






