/** Labels must be authored from source review, independently of engine scores.
 * start/end enclose the required setup through payoff; optional payoffAt is
 * reference evidence, never the candidate's self-reported payoff. */
export interface MomentLabel { id: string; start: number; end: number; payoffAt?: number }
export interface ClipReview {
  index: number;
  verdict: "publishable" | "boring" | "not_publishable" | "unknown";
  momentId?: string;
  startOk?: boolean;
  endOk?: boolean;
  contextOk?: boolean;
}
type Range = { start: number; end: number };
const validRange = (r: Range) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start;

export function measureMomentQuality(clips: readonly Range[], moments: readonly MomentLabel[], reviews: readonly ClipReview[] = []) {
  if (clips.some(c => !validRange(c)) || moments.some(m => !validRange(m) || !m.id || (m.payoffAt !== undefined && (!Number.isFinite(m.payoffAt) || m.payoffAt < m.start || m.payoffAt > m.end)))) throw new Error("invalid moment or clip range");
  if (new Set(moments.map(m => m.id)).size !== moments.length) throw new Error("duplicate moment label");
  const byIndex = new Map<number, ClipReview>();
  for (const r of reviews) {
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= clips.length || byIndex.has(r.index) || !["publishable", "boring", "not_publishable", "unknown"].includes(r.verdict)) throw new Error("invalid or duplicate clip review");
    if (r.verdict === "publishable" && !r.momentId?.trim()) throw new Error("publishable review requires a moment ID");
    byIndex.set(r.index, r);
  }
  // Full required semantic interval, not a majority-overlap shortcut that can
  // count a setup-only fragment. A source's duplicate cuts count once for recall.
  const found = moments.filter(m => clips.some(c => c.start <= m.start && c.end >= m.end && (m.payoffAt === undefined || (c.start <= m.payoffAt && c.end >= m.payoffAt))));
  const foundIds = new Set(found.map(m => m.id));
  const reviewed = [...byIndex.values()].filter(r => r.verdict !== "unknown");
  const publishable = reviewed.filter(r => r.verdict === "publishable");
  const uniquePublishable = (rs: readonly ClipReview[]) => new Set(rs.filter(r => r.verdict === "publishable").map(r => r.momentId)).size;
  const top = (k: number) => {
    const n = Math.min(k, clips.length);
    const rs = reviewed.filter(r => r.index < n);
    const yes = rs.filter(r => r.verdict === "publishable").length;
    const unknown = n - rs.length;
    return { delivered: n, reviewed: rs.length, precision: n && !unknown ? yes / n : null,
      lowerBound: n ? yes / n : null, upperBound: n ? (yes + unknown) / n : null,
      fixedKYield: unknown ? null : uniquePublishable(rs) / k, fixedKYieldLowerBound: uniquePublishable(rs) / k };
  };
  const boundary = (key: "startOk" | "endOk" | "contextOk") => ({ assessed: reviews.filter(r => typeof r[key] === "boolean").length, failed: reviews.filter(r => r[key] === false).length });
  return {
    moments: moments.length, found: found.length, missed: moments.filter(m => !foundIds.has(m.id)).map(m => m.id),
    recall: moments.length ? found.length / moments.length : null,
    clips: clips.length, empty: clips.length === 0, reviewedClips: reviewed.length, unknownClips: clips.length - reviewed.length,
    publishableClips: uniquePublishable(publishable), boringClips: reviewed.filter(r => r.verdict === "boring").length,
    top3: top(3), top5: top(5), start: boundary("startOk"), end: boundary("endOk"), context: boundary("contextOk"),
  };
}
