import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

/**
 * A SOURCE-LEVEL guard, not a behavioural one, and that is deliberate.
 *
 * The defect this protects against cannot be reproduced by a unit test: it
 * needs a child chatty enough to push more than 1 MiB through a pipe, which in
 * practice means a real ffmpeg run over a real user's video. It had already
 * been found and fixed twice - in download.ts and in the reframe modules - and
 * came back anyway in the render path, because each fix was a literal beside
 * one call and nothing connected them. On 2026-08-04 it killed the first
 * YouTube job a real user ever got through, after DOWNLOAD, TRANSCRIBE and
 * ANALYZE had all succeeded.
 *
 * So the invariant worth pinning is not "this call behaves" but "no call site
 * is missing the option". A grep is the honest shape for that.
 */

const SRC = join(__dirname, "..");

/** Directories whose children are tooling, not the pipeline. */
const SKIP_DIRS = new Set(["__tests__", "scripts", "node_modules", "dist"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Call sites, as `file:line`, that spawn a child without naming a maxBuffer.
 *
 *  Matching is textual and intentionally crude: it looks at the call and the
 *  lines that follow it up to the closing `);`. A false positive here costs a
 *  developer one comment; a false negative costs a user their job. */
function callSitesMissingMaxBuffer(): string[] {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/\b(execFileAsync|execFile|promisify\(execFile\))\s*\(/.test(line)) return;
      // Skip ONLY the wrapper's own definition and imports - never "starts with
      // const", which is how most real calls begin (`const { stderr } = await
      // execFileAsync(...)`). An earlier version of this line skipped those and
      // the guard passed while a maxBuffer was deliberately deleted from
      // runSilenceDetect: green, and worthless. Verified by re-running that
      // deletion against this version.
      if (/=\s*promisify\(/.test(line)) return;
      if (/^\s*import\b/.test(line)) return;

      // Read forward to the end of this call expression.
      let depth = 0;
      let body = "";
      for (let j = i; j < Math.min(lines.length, i + 40); j++) {
        body += lines[j] + "\n";
        for (const ch of lines[j]) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        if (depth <= 0 && j > i) break;
      }
      // A forwarded options object counts. `runYtDlpWithRotation` takes
      // `options: { maxBuffer: number }` - a REQUIRED property - so the
      // compiler already refuses a caller that omits it, and the type is a
      // stronger guarantee than this grep could be. Only a bare identifier is
      // accepted; an inline object literal still has to spell maxBuffer out.
      const forwardsOptions = /,\s*(options|opts)\s*\)/.test(body);
      if (!/maxBuffer/.test(body) && !forwardsOptions) {
        offenders.push(`${file.replace(SRC, "")}:${i + 1}`);
      }
    });
  }
  return offenders;
}

describe("child process buffering", () => {
  it("is 16 MiB - the value the two independent earlier fixes converged on", () => {
    expect(CHILD_MAX_BUFFER_BYTES).toBe(16 * 1024 * 1024);
  });

  // Node's default is 1 MiB PER STREAM and it kills the child rather than
  // truncating, so anything at or below the default is not a cap, it is the bug.
  it("is far above Node's 1 MiB default", () => {
    expect(CHILD_MAX_BUFFER_BYTES).toBeGreaterThan(8 * 1024 * 1024);
  });

  it("every pipeline call site passes it", () => {
    const offenders = callSitesMissingMaxBuffer();
    expect(
      offenders,
      `These spawn a child without a maxBuffer, so ffmpeg's stderr can kill the ` +
        `job at Node's 1 MiB default. Import CHILD_MAX_BUFFER_BYTES and pass it:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});
