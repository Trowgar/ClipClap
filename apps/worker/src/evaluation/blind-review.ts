import { createHash } from "node:crypto";

export interface BlindClipInput {
  sourceId: string;
  version: "baseline" | "candidate";
  rank: number;
  start: number;
  end: number;
  title?: string;
  description?: string;
  transcript?: string;
  before?: string;
  after?: string;
}

const id = (salt: string, value: string) => createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 12);
const normalizedCopy = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
const equivalent = (a: BlindClipInput, b: BlindClipInput) => {
  if (a.sourceId !== b.sourceId) return false;
  if (normalizedCopy(a.title) !== normalizedCopy(b.title)) return false;
  if (normalizedCopy(a.description) !== normalizedCopy(b.description)) return false;
  if (normalizedCopy(a.transcript) !== normalizedCopy(b.transcript)) return false;
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return Math.abs(a.start - b.start) <= 0.75 && Math.abs(a.end - b.end) <= 0.75 && overlap / union >= 0.97;
};

export function buildBlindReviewSet(inputs: readonly BlindClipInput[], salt: string) {
  if (!salt || inputs.some(x => !x.sourceId || !Number.isInteger(x.rank) || x.rank < 0 || x.start < 0 || x.end <= x.start)) {
    throw new Error("invalid blind review input");
  }
  const ordered = [...inputs].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) ||
    a.start - b.start || a.end - b.end ||
    normalizedCopy(a.title).localeCompare(normalizedCopy(b.title)) ||
    normalizedCopy(a.description).localeCompare(normalizedCopy(b.description)) ||
    normalizedCopy(a.transcript).localeCompare(normalizedCopy(b.transcript)) ||
    normalizedCopy(a.before).localeCompare(normalizedCopy(b.before)) ||
    normalizedCopy(a.after).localeCompare(normalizedCopy(b.after)) ||
    (a.version === b.version ? 0 : a.version === "baseline" ? -1 : 1) ||
    a.rank - b.rank
  );
  const clusters: BlindClipInput[][] = [];
  for (const input of ordered) {
    const cluster = clusters.find(items => items.some(item => equivalent(item, input)));
    if (cluster) cluster.push(input); else clusters.push([input]);
  }
  const usedIds = new Set<string>();
  const rows = clusters.map(items => {
    const representative = items[0];
    const boundaryKey = `${representative.sourceId}:${representative.start.toFixed(3)}:${representative.end.toFixed(3)}`;
    const baseId = id(salt, boundaryKey);
    const blindId = usedIds.has(baseId)
      ? id(salt, `${boundaryKey}:${normalizedCopy(representative.title)}:${normalizedCopy(representative.description)}:${normalizedCopy(representative.transcript)}`)
      : baseId;
    usedIds.add(blindId);
    return {
      review: {
        blindId,
        blindSourceId: id(salt, representative.sourceId),
        start: representative.start,
        end: representative.end,
        duration: representative.end - representative.start,
        title: representative.title,
        description: representative.description,
        transcript: representative.transcript,
        before: representative.before,
        after: representative.after,
      },
      mapping: {
        blindId,
        sourceId: representative.sourceId,
        placements: items.map(({ version, rank, start, end }) => ({ version, rank, start, end })),
      },
    };
  }).sort((a, b) => a.review.blindId.localeCompare(b.review.blindId));
  return { review: rows.map(x => x.review), mapping: rows.map(x => x.mapping) };
}
