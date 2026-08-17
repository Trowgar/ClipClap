/**
 * Materialises the director-audit corpus from its committed manifest.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/director-audit-fetch.ts [--clips]"
 *
 * Sources (one per job) go to <outDir>/sources/<jobId>.mp4; with --clips the
 * rendered clips go to <outDir>/clips/<clipId>.mp4 too. Existing non-empty
 * files are kept. Read-only against R2. The manifest is committed, the videos
 * are not: .corpus/ is gitignored and outside the Job table, so the retention
 * sweep cannot reach it - the same reason corpus-fetch.ts exists.
 */
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import { downloadFile } from "@clipclap/shared";
import { reframeAssetsDir } from "../reframe/faces";

export interface DirectorAuditItem {
  job: string;
  clip: string;
  sourceKey: string;
  clipKey: string;
  start: number;
  end: number;
  source: { width: number; height: number };
  shots: Array<{ start: number; end: number; layout: string; x: number }>;
}

export interface DirectorAuditManifest {
  note: string;
  outDir: string;
  items: DirectorAuditItem[];
}

export function manifestPath(): string {
  return join(reframeAssetsDir(), "director-audit.json");
}

/** Worker root: assets/reframe sits at apps/worker/assets/reframe. */
export function workerRoot(): string {
  return join(reframeAssetsDir(), "..", "..");
}

export async function loadManifest(): Promise<DirectorAuditManifest> {
  return JSON.parse(await readFile(manifestPath(), "utf-8")) as DirectorAuditManifest;
}

async function present(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function save(key: string, out: string): Promise<string> {
  if (await present(out)) return "cached";
  const stream = await downloadFile(key);
  const buf = Buffer.from(await new Response(stream).arrayBuffer());
  await writeFile(out, buf);
  return `${buf.length} bytes`;
}

async function main() {
  const withClips = process.argv.includes("--clips");
  const manifest = await loadManifest();
  const dir = join(workerRoot(), manifest.outDir);
  await mkdir(join(dir, "sources"), { recursive: true });
  await mkdir(join(dir, "clips"), { recursive: true });
  const seenJobs = new Set<string>();
  for (const item of manifest.items) {
    if (!seenJobs.has(item.job)) {
      seenJobs.add(item.job);
      try {
        console.log("source", item.job, await save(item.sourceKey, join(dir, "sources", `${item.job}.mp4`)));
      } catch (e) {
        console.log("source", item.job, "ERR", (e as Error).name ?? e);
      }
    }
    if (withClips) {
      try {
        console.log("clip", item.clip, await save(item.clipKey, join(dir, "clips", `${item.clip}.mp4`)));
      } catch (e) {
        console.log("clip", item.clip, "ERR", (e as Error).name ?? e);
      }
    }
  }
}

// Same guard as corpus-fetch.ts: eval-cut-recovery.ts imports the helpers
// above, and importing must not start a download.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
