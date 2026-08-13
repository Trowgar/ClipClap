// apps/worker/src/scripts/asr-align.ts
/**
 * LCS token alignment for ASR transcript comparison (Groq ASR spec §4.3).
 *
 * The normalization is the stitcher's norm (audio-chunks.ts) on purpose:
 * lowercase, strip everything that is not a letter or digit, and NO ё->е
 * folding - engine-notes §1 measured the whisper-1 self-jitter with ё/е
 * divergence visible as substitutions, and these numbers must stay comparable
 * to that envelope.
 *
 * Hunk accounting: inside each run of non-matching tokens, min(dels, ins)
 * pairs up as substitutions and the remainder stays pure ins/del. That is what
 * makes "14 substitutions, 28 insertions, 25 deletions" the shape it is.
 */

export interface AlignCounts {
  tokensA: number;
  tokensB: number;
  matches: number;
  substitutions: number;
  /** Tokens present in B but not in A. */
  insertions: number;
  /** Tokens present in A but not in B. */
  deletions: number;
}

export const normToken = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function alignTokens(rawA: string[], rawB: string[]): AlignCounts {
  const A = rawA.map(normToken).filter((t) => t !== "");
  const B = rawB.map(normToken).filter((t) => t !== "");
  const n = A.length;
  const m = B.length;
  // Uint16 holds the LCS length, and the table is O(n*m) cells - a 52-min
  // episode is ~7k tokens per side, ~100MB. Cap the AREA, not just each side:
  // two 60k-token sides would pass a per-dimension check and then attempt a
  // ~7GB allocation on a host shared with the render workers.
  if (n >= 65535 || m >= 65535 || n * m >= 64_000_000) {
    throw new Error(`sequences too long for LCS table: ${n} x ${m}`);
  }
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * W + j] =
        A[i - 1] === B[j - 1]
          ? dp[(i - 1) * W + (j - 1)] + 1
          : Math.max(dp[(i - 1) * W + j], dp[i * W + (j - 1)]);
    }
  }
  let i = n;
  let j = m;
  let matches = 0;
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let hunkDel = 0;
  let hunkIns = 0;
  const closeHunk = () => {
    const s = Math.min(hunkDel, hunkIns);
    substitutions += s;
    deletions += hunkDel - s;
    insertions += hunkIns - s;
    hunkDel = 0;
    hunkIns = 0;
  };
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      closeHunk();
      matches++;
      i--;
      j--;
    } else if (dp[(i - 1) * W + j] >= dp[i * W + (j - 1)]) {
      // Tie-break prefers deletion. With repeated tokens several equally
      // optimal alignments exist; the total edit count is invariant, only the
      // substitution-vs-pure-indel split inside a hunk can shift. Fixed one
      // way so runs are deterministic and comparable across measurements.
      hunkDel++;
      i--;
    } else {
      hunkIns++;
      j--;
    }
  }
  hunkDel += i;
  hunkIns += j;
  closeHunk();
  return { tokensA: n, tokensB: m, matches, substitutions, insertions, deletions };
}
