/** Fingerprints for "have we seen this exact source from this user before?"
 *
 *  Three of the first fifteen outside users resent the same source: one link
 *  three times, two different files twice each. Every repeat was a full paid
 *  run (probe, download, transcription, analysis, render) that produced the
 *  clips they already had - or, when the first run was still going, a second
 *  copy of it. Nothing recognised the repeat because nothing stored a key for
 *  it: Job.sourceUrl is the raw string (`youtu.be/x?si=...` and
 *  `youtube.com/watch?v=x` are different rows), and an uploaded file's identity
 *  was never written down at all.
 *
 *  Two keys, both free:
 *    url:<normalized>   for links - see normalizeSourceUrl
 *    tg:<file_unique_id> for Telegram uploads - Telegram's own stable id for
 *                        the bytes, the same across forwards and re-sends
 *
 *  Web file uploads get no fingerprint (a fresh R2 key per upload, no content
 *  hash) - the web has had zero real jobs, so that gap costs nothing yet.
 */

/** Tracking and share-sheet noise that does not change WHICH video a link
 *  points at. Deliberately a short list of the ones actually seen; a param not
 *  on it survives normalisation, so an unknown-but-meaningful one is never
 *  stripped by mistake. */
const NOISE_PARAMS = new Set([
  "si",
  "feature",
  "fbclid",
  "gclid",
  "igshid",
  "ref",
  "ref_src",
  "share_id",
  "_r",
  "t",
  "time_continue",
  "ab_channel",
  "pp",
]);

function isNoise(name: string): boolean {
  return name.startsWith("utm_") || NOISE_PARAMS.has(name.toLowerCase());
}

/** The canonical form of a video URL: one string per video, whatever share
 *  button produced the link. Returns null when the string is not a URL.
 *
 *  YouTube collapses to `youtube.com/watch?v=<id>` - youtu.be, m., music.,
 *  /shorts/, /live/, /embed/ included, because they are the same upload.
 *  Everything else keeps its host (minus www.) and path, drops the noise
 *  params above and the hash, and sorts what is left. */
export function normalizeSourceUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  const ytId = youtubeVideoId(host, u);
  if (ytId) return `https://youtube.com/watch?v=${ytId}`;

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !isNoise(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = params.length
    ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  return `https://${host}${path}${search}`;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeVideoId(host: string, u: URL): string | null {
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return id && YT_ID.test(id) ? id : null;
  }
  const isYouTube =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");
  if (!isYouTube) return null;

  const v = u.searchParams.get("v");
  if (v && YT_ID.test(v)) return v;
  const m = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname);
  return m ? m[1] : null;
}

/** `url:<normalized>` or null for a string that is not a URL. */
export function urlSourceFingerprint(raw: string): string | null {
  const n = normalizeSourceUrl(raw);
  return n ? `url:${n}` : null;
}

/** `tg:<file_unique_id>` - Telegram's stable identity for the uploaded bytes. */
export function telegramSourceFingerprint(fileUniqueId: string): string {
  return `tg:${fileUniqueId}`;
}
