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
 * yt-dlp goes through the WARP proxy (see CLAUDE.md); YTDLP_PROXY is honoured
 * exactly as the download processor honours it.
 */
import { execFile } from "child_process";
import { mkdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { reframeAssetsDir } from "../reframe/faces";

const execFileAsync = promisify(execFile);

interface CorpusItem {
  id: string;
  url: string;
  in: string;
  len: number;
  tests: string;
}

export interface CorpusManifest {
  outDir: string;
  items: CorpusItem[];
}

export async function loadManifest(): Promise<CorpusManifest> {
  const raw = await readFile(join(reframeAssetsDir(), "corpus.json"), "utf-8");
  return JSON.parse(raw) as CorpusManifest;
}

/** Absolute path a materialised item lands at. Callers use this rather than
 *  rebuilding the join, so the layout is defined in exactly one place. */
export function corpusPath(manifest: CorpusManifest, id: string): string {
  return join("/app/apps/worker", manifest.outDir, `${id}.mp4`);
}

async function main() {
  const manifest = await loadManifest();
  const dir = join("/app/apps/worker", manifest.outDir);
  await mkdir(dir, { recursive: true });

  for (const item of manifest.items) {
    const out = join(dir, `${item.id}.mp4`);
    if (!item.url) {
      console.warn(`skip ${item.id}: no url in the manifest (${item.tests})`);
      continue;
    }
    const existing = await stat(out).catch(() => null);
    if (existing && existing.size > 0) {
      console.log(`have ${item.id} (${(existing.size / 1e6).toFixed(1)} MB)`);
      continue;
    }
    const args = [
      "-f", "bv*[height<=1080]+ba/b[height<=1080]",
      "--download-sections", `*${item.in}-+${item.len}`,
      "--force-keyframes-at-cuts",
      "--merge-output-format", "mp4",
      "-o", out,
      item.url,
    ];
    if (process.env.YTDLP_PROXY) args.unshift("--proxy", process.env.YTDLP_PROXY);
    console.log(`fetch ${item.id} ...`);
    try {
      await execFileAsync("yt-dlp", args, { maxBuffer: CHILD_MAX_BUFFER_BYTES });
      const got = await stat(out);
      console.log(`  ok ${item.id} (${(got.size / 1e6).toFixed(1)} MB)`);
    } catch (error) {
      console.error(`  FAILED ${item.id}: ${(error as Error).message.slice(0, 200)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
