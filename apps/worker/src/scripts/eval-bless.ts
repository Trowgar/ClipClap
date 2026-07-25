/**
 * Re-blesses eval snapshots after a DELIBERATE engine change.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-bless.ts [case-name ...]"
 *
 * Replays every fixture (or only the ones named) through the real engine with
 * recorded LLM responses, compares the result to the blessed snapshot, prints a
 * readable diff of what moved, and only then rewrites snapshot.json.
 *
 * The diff is the point. It is the review artefact a human reads to decide
 * whether the change is desirable - two pretty-printed JSON blobs to compare by
 * eye is how a wrong snapshot gets blessed by accident.
 *
 * Costs nothing: replay is offline. Unchanged fixtures are not rewritten, so a
 * no-op run leaves the working tree clean.
 *
 * REFUSES to bless a fixture whose recorded engine fingerprint does not match
 * the current config: there the RESPONSES are stale, not the snapshot, and
 * blessing would carve a shape the current engine never actually produced into
 * the repo. eval-record.ts is the fix for that, not this script.
 */
import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  FIXTURES_DIR,
  loadFixture,
  runFixture,
  toShape,
  type EvalShape,
} from "../__tests__/helpers/eval-fixture";
import { compareFingerprints, computeFingerprint } from "../__tests__/helpers/eval-fingerprint";
import { loadAnalyzeConfig } from "../analyze-v2/config";

type Clip = EvalShape["clips"][number];

function parseRange(range: string): { start: number; end: number } {
  const [start, end] = range.split("-").map(Number);
  return { start: start ?? 0, end: end ?? 0 };
}

function overlap(a: string, b: string): number {
  const x = parseRange(a);
  const y = parseRange(b);
  return Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
}

function fmt(clip: Clip, index: number): string {
  return `#${index + 1} ${clip.range} [${clip.score}] ${clip.title}`;
}

interface Pair {
  oldIndex: number;
  newIndex: number;
}

/**
 * Pairs blessed clips with current ones so the diff can say "this clip moved"
 * instead of "one clip vanished and an unrelated one appeared".
 *
 * Identical clips pair first (so a pure reorder never gets misread as a
 * rewrite), then the remainder pair greedily by largest time overlap. A clip
 * with no overlapping counterpart is genuinely gone / genuinely new.
 */
function pairClips(before: Clip[], after: Clip[]): { pairs: Pair[]; removed: number[]; added: number[] } {
  const pairs: Pair[] = [];
  const oldTaken = new Set<number>();
  const newTaken = new Set<number>();

  const identity = (c: Clip) => `${c.range}|${c.score}|${c.title}`;
  before.forEach((oldClip, oldIndex) => {
    const newIndex = after.findIndex(
      (newClip, i) => !newTaken.has(i) && identity(newClip) === identity(oldClip)
    );
    if (newIndex >= 0) {
      pairs.push({ oldIndex, newIndex });
      oldTaken.add(oldIndex);
      newTaken.add(newIndex);
    }
  });

  const candidates: Array<Pair & { score: number }> = [];
  before.forEach((oldClip, oldIndex) => {
    if (oldTaken.has(oldIndex)) return;
    after.forEach((newClip, newIndex) => {
      if (newTaken.has(newIndex)) return;
      const shared = overlap(oldClip.range, newClip.range);
      if (shared > 0) candidates.push({ oldIndex, newIndex, score: shared });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (oldTaken.has(c.oldIndex) || newTaken.has(c.newIndex)) continue;
    pairs.push({ oldIndex: c.oldIndex, newIndex: c.newIndex });
    oldTaken.add(c.oldIndex);
    newTaken.add(c.newIndex);
  }

  return {
    pairs: pairs.sort((a, b) => a.newIndex - b.newIndex),
    removed: before.map((_, i) => i).filter((i) => !oldTaken.has(i)),
    added: after.map((_, i) => i).filter((i) => !newTaken.has(i)),
  };
}

/** Human-readable diff of two shapes. Empty array means identical. */
export function diffShapes(before: EvalShape | null, after: EvalShape): string[] {
  const lines: string[] = [];
  if (before === null) {
    lines.push("  no blessed snapshot yet - this run establishes the baseline:");
    after.clips.forEach((c, i) => lines.push(`  + ADDED    ${fmt(c, i)}`));
    return lines;
  }

  if (before.count !== after.count) lines.push(`  count:  ${before.count} -> ${after.count}`);
  if (before.tier !== after.tier) lines.push(`  tier:   ${before.tier} -> ${after.tier}`);
  if (before.noClipsReason !== after.noClipsReason) {
    lines.push(
      `  noClipsReason: ${before.noClipsReason ?? "(none)"} -> ${after.noClipsReason ?? "(none)"}`
    );
  }

  const { pairs, removed, added } = pairClips(before.clips, after.clips);
  for (const i of removed) lines.push(`  - REMOVED  ${fmt(before.clips[i]!, i)}`);
  for (const i of added) lines.push(`  + ADDED    ${fmt(after.clips[i]!, i)}`);

  for (const { oldIndex, newIndex } of pairs) {
    const oldClip = before.clips[oldIndex]!;
    const newClip = after.clips[newIndex]!;
    const changes: string[] = [];
    if (oldClip.range !== newClip.range) {
      const o = parseRange(oldClip.range);
      const n = parseRange(newClip.range);
      const shift = [
        n.start !== o.start ? `start ${(n.start - o.start >= 0 ? "+" : "")}${(n.start - o.start).toFixed(1)}s` : null,
        n.end !== o.end ? `end ${(n.end - o.end >= 0 ? "+" : "")}${(n.end - o.end).toFixed(1)}s` : null,
      ]
        .filter(Boolean)
        .join(", ");
      changes.push(`range   ${oldClip.range} -> ${newClip.range}  (${shift})`);
    }
    if (oldClip.score !== newClip.score) {
      changes.push(`score   ${oldClip.score} -> ${newClip.score}`);
    }
    if (oldClip.title !== newClip.title) {
      changes.push(`title   "${oldClip.title}"\n              -> "${newClip.title}"`);
    }
    if (oldIndex !== newIndex) changes.push(`rank    #${oldIndex + 1} -> #${newIndex + 1}`);
    if (changes.length === 0) continue;
    // Label by the strongest thing that changed, so a reader can skim the left
    // column: a re-cut clip and a merely re-ranked one are different news.
    const label =
      oldClip.range !== newClip.range
        ? "MOVED   "
        : oldClip.score !== newClip.score || oldClip.title !== newClip.title
          ? "CHANGED "
          : "RERANKED";
    lines.push(`  ~ ${label} ${newClip.range} ${newClip.title}`);
    for (const change of changes) lines.push(`      ${change}`);
  }

  const reasonKeys = [
    ...new Set([...Object.keys(before.dropReasons), ...Object.keys(after.dropReasons)]),
  ].sort();
  for (const key of reasonKeys) {
    const a = before.dropReasons[key] ?? 0;
    const b = after.dropReasons[key] ?? 0;
    if (a !== b) lines.push(`  dropReason ${key}: ${a} -> ${b}`);
  }

  return lines;
}

function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(FIXTURES_DIR, e.name, "transcript.json")))
    .map((e) => e.name)
    .sort();
}

async function main() {
  const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const available = listFixtures();
  const cases = names.length > 0 ? names : available;

  const unknown = cases.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    console.error(`unknown fixture(s): ${unknown.join(", ")}`);
    console.error(`available: ${available.join(", ")}`);
    process.exit(1);
  }

  const current = computeFingerprint({ ...loadAnalyzeConfig({}), engine: "recall-critic" });
  let changed = 0;
  let refused = 0;
  let failed = 0;

  for (const name of cases) {
    const fixture = loadFixture(name);

    // Fingerprint first, and as a refusal rather than a throw: the fixture's
    // RECORDING is what is stale here. Blessing would freeze a shape produced
    // from answers the current engine would never have received.
    if (fixture.fingerprint) {
      const { mismatches } = compareFingerprints(fixture.fingerprint, current);
      if (mismatches.length > 0) {
        refused++;
        console.log(`${name}: REFUSED - recorded under a different engine config`);
        for (const m of mismatches) console.log(`    - ${m}`);
        console.log(
          `    The responses are stale, not the snapshot, so blessing would carve in a shape\n` +
            `    the current engine never produced. Either revert the knob(s) above, or re-record:\n` +
            `      docker compose exec worker-analyze sh -c "cd /app/apps/worker && ` +
            `npx tsx src/scripts/eval-record.ts <jobId> ${name}"`
        );
        continue;
      }
    } else {
      console.log(
        `${name}: WARNING - no meta.json fingerprint, cannot verify the recording matches ` +
          `the current config. Re-record with eval-record.ts.`
      );
    }

    let shape: EvalShape;
    try {
      shape = toShape(await runFixture(fixture));
    } catch (err) {
      failed++;
      console.log(`${name}: ERROR - ${(err as Error).message}`);
      continue;
    }

    const lines = diffShapes(fixture.snapshot, shape);
    if (lines.length === 0) {
      console.log(`${name}: unchanged`);
      continue;
    }

    changed++;
    console.log(`${name}: CHANGED`);
    for (const line of lines) console.log(line);
    writeFileSync(
      join(FIXTURES_DIR, name, "snapshot.json"),
      `${JSON.stringify(shape, null, 2)}\n`,
      "utf-8"
    );
    console.log(`  -> rewrote ${join(FIXTURES_DIR, name, "snapshot.json")}`);
  }

  console.log(
    `\n${cases.length} fixture(s): ${cases.length - changed - refused - failed} unchanged, ` +
      `${changed} re-blessed, ${refused} refused, ${failed} errored`
  );
  if (changed > 0) {
    console.log("Read the diff above before committing - that diff IS the review of the change.");
  }
  process.exit(refused + failed > 0 ? 1 : 0);
}

main();
