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
  // Uint16 holds the LCS length; a 52-min episode is ~7k tokens, the table is
  // ~100MB. Refuse absurd inputs instead of silently overflowing.
  if (n >= 65535 || m >= 65535) throw new Error(`sequence too long for LCS table: ${n} x ${m}`);
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
