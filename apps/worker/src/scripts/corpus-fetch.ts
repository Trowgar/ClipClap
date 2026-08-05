/**
 * Materialises the reframe corpus from its committed manifest.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/corpus-fetch.ts"
 *
 * The manifest is committed, the videos are not. This exists because the
 * retention sweep deleted every source video this project had, including the
 * one engine-notes 7b and 7c rest on - so a corpus that lives inside the job
 * system is a corpus that disappears. `.corpus/` is outside R2, outside the
 * Job table and in .gitignore.
 *
 * Nine sequential YouTube fetches on one WARP exit is the highest-probability
 * bot-check scenario in this project, and rotation is what made YouTube work at
 * all - so this uses the SAME proxy args and the SAME rotate-and-retry wrapper
 * the download processor uses, rather than re-reading the env inline.
 */
import { mkdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { proxyArgs } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { runYtDlpWithRotation } from "../processors/download";
import { reframeAssetsDir } from "../reframe/faces";

export interface CorpusItem {
  id: string;
  /** Empty until a human fills it in; such items are skipped, not failed. */
  url: string;
  /** Start offset, `HH:MM:SS` or plain seconds. */
  in: string;
  /** Duration in seconds. NOT an end time - see sectionArg. */
  len: number;
  tests: string;
}

export interface CorpusManifest {
  outDir: string;
  items: CorpusItem[];
}

/** Seconds from `HH:MM:SS`, `MM:SS` or a plain number. */
export function toSeconds(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`corpus: unparseable time ${JSON.stringify(value)}`);
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * yt-dlp's `--download-sections` value.
 *
 * The second component is an ABSOLUTE END, not a duration, so `len` has to be
 * added to `in` rather than pasted after the hyphen. `*00:00:00-+90` - the
 * obvious-looking form - is rejected outright by yt-dlp 2026.07.04 with
 * "invalid --download-sections time range", an argv parse error that fails
 * every item identically before any network work. Seconds on both sides,
 * because the timestamp form has to be reassembled and there is nothing to gain
 * from it.
 */
export function sectionArg(item: CorpusItem): string {
  const start = toSeconds(item.in);
  return `*${start}-${start + item.len}`;
}

export async function loadManifest(): Promise<CorpusManifest> {
  const raw = await readFile(join(reframeAssetsDir(), "corpus.json"), "utf-8");
  const parsed = JSON.parse(raw) as Partial<CorpusManifest>;
  // Structural check rather than a bare cast, the house style for a parsed
  // external contract (see parseDetectorOutput). A malformed manifest would
  // otherwise hand consumers an undefined `items` and surface as a TypeError
  // far from the cause.
  if (typeof parsed.outDir !== "string" || !Array.isArray(parsed.items)) {
    throw new Error("corpus: manifest must have outDir and items");
  }
  for (const item of parsed.items) {
    if (
      typeof item?.id !== "string" ||
      typeof item?.url !== "string" ||
      typeof item?.in !== "string" ||
      typeof item?.len !== "number"
    ) {
      throw new Error(`corpus: malformed item ${JSON.stringify(item?.id)}`);
    }
  }
  return parsed as CorpusManifest;
}

/** Where a materialised item lands. Resolved from `__dirname` rather than a
 *  hardcoded `/app/...`, so it is correct under tsx and under the dist layout,
 *  and matches how the manifest itself is located. */
export function corpusDir(manifest: CorpusManifest): string {
  return join(__dirname, "..", "..", manifest.outDir);
}

export function corpusPath(manifest: CorpusManifest, id: string): string {
  return join(corpusDir(manifest), `${id}.mp4`);
}

async function main() {
  const manifest = await loadManifest();
  const dir = corpusDir(manifest);
  await mkdir(dir, { recursive: true });

  let fetched = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of manifest.items) {
    const out = join(dir, `${item.id}.mp4`);
    if (!item.url) {
      console.warn(`skip ${item.id}: no url in the manifest (${item.tests})`);
      skipped += 1;
      continue;
    }
    // Existence, not integrity: a download truncated by a full disk stays a
    // permanent cache hit. Acceptable because every comparison this corpus
    // feeds is our own render against our own baseline from the SAME file, so
    // a short fixture yields less material rather than a wrong answer.
    const existing = await stat(out).catch(() => null);
    if (existing && existing.size > 0) {
      console.log(`have ${item.id} (${(existing.size / 1e6).toFixed(1)} MB)`);
      fetched += 1;
      continue;
    }
    console.log(`fetch ${item.id} ...`);
    try {
      await runYtDlpWithRotation(
        [
          ...proxyArgs(),
          "-f", "bv*[height<=1080]+ba/b[height<=1080]",
          "--download-sections", sectionArg(item),
          "--force-keyframes-at-cuts",
          "--merge-output-format", "mp4",
          "-o", out,
          item.url,
        ],
        { maxBuffer: CHILD_MAX_BUFFER_BYTES }
      );
      const got = await stat(out);
      console.log(`  ok ${item.id} (${(got.size / 1e6).toFixed(1)} MB)`);
      fetched += 1;
    } catch (error) {
      // stderr, not message. Node builds message as "Command failed: " plus the
      // whole command line, which is 239 chars without the proxy and 266 with
      // it BEFORE stderr begins - so any truncation of `message` is guaranteed
      // to cut exactly the reason and keep only the arguments.
      const stderr = (error as { stderr?: string })?.stderr ?? "";
      const reason = stderr.trim() || (error as Error).message;
      console.error(`  FAILED ${item.id}: ${reason.slice(-400)}`);
      failed += 1;
    }
  }

  console.log(
    `\n${fetched} available, ${failed} failed, ${skipped} awaiting a url in the manifest`
  );
  // A non-zero exit when something with a url did not materialise: without it
  // the documented command "succeeds" against an empty .corpus/ and no caller
  // can tell a ready corpus from total failure.
  if (failed > 0) process.exitCode = 1;
}

// Only when run directly. `loadManifest`, `corpusPath` and `sectionArg` are
// imported by the baseline and measurement scripts, and an unguarded main()
// would spawn nine downloads as an import side effect. Same guard as
// eval-bless.ts, typeof-checked for the same reason: tsx loads this as CJS
// while vitest transforms it to ESM.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
