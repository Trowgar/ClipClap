type Range = { start: number; end: number };
type Feedback = { verdict: string; snapshot?: { startTime?: number; endTime?: number } | null };
const valid = (r: Range) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start;

/** Historical client judgments belong to their immutable interval snapshot.
 * Retention/repetition measure moment selection, not renewed approval of a
 * changed title or render. EDIT is not approval or rejection. */
export function measureCustomerFeedback(clips: readonly Range[], feedback: readonly Feedback[]) {
  if (clips.some(c => !valid(c))) throw new Error("invalid clip range");
  const refs = feedback.map(f => {
    if (!["AS_IS", "EDIT", "NO"].includes(f.verdict)) throw new Error("invalid feedback verdict");
    const range = { start: f.snapshot?.startTime as number, end: f.snapshot?.endTime as number };
    if (!valid(range)) throw new Error("feedback requires a valid interval snapshot");
    return { ...range, verdict: f.verdict };
  });
  const unique = [...new Map(refs.map(r => [`${r.verdict}:${r.start}:${r.end}`, r])).values()];
  const accepted = unique.filter(r => r.verdict === "AS_IS");
  const rejected = unique.filter(r => r.verdict === "NO");
  const tolerance = 0.001; // float serialization, far below one video frame
  return {
    accepted: accepted.length,
    acceptedCovered: accepted.filter(r => clips.some(c => c.start <= r.start + tolerance && c.end >= r.end - tolerance)).length,
    rejected: rejected.length,
    rejectedRepeated: rejected.filter(r => clips.some(c => Math.abs(c.start - r.start) <= tolerance && Math.abs(c.end - r.end) <= tolerance)).length,
    editRequested: unique.filter(r => r.verdict === "EDIT").length,
  };
}
