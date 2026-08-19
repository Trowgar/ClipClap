# Surviving YouTube's exit flaps for free (2026-08-19, APPROVED - owner: "нет средств, найди решение")

## 0. The problem, measured

The WARP v4 exit is pinned by Cloudflare (GeoExit - consistent egress by design;
0 moves in 10 attempts across reconnect/re-registration/protocol/container).
YouTube throttles that shared exit in two modes, both of which COME AND GO on
their own: (a) soft - metadata OK, every googlevideo segment 403 (a GVS
PO-token demand); (b) hard - bot check on metadata itself. Yesterday an episode
lasted ~25 minutes; today's ran hours. Current behaviour: DOWNLOAD burns its 3
BullMQ attempts in ~30 seconds and the job dies - a real user's job died
exactly this way on 2026-08-19 10:40. Paid egress is off the table for now.

## 1. Solution B (build FIRST - certain benefit): wait the flap out at DOWNLOAD

A 403/bot-check failure of a URL download is not a dead link - it is weather.
Instead of failing the attempt, the download stage parks the job in BullMQ's
delayed set and retries after the flap has had time to pass.

- Detection: the download failed AND its error text matches the flap classes -
  `isBotCheckFailure` or a bare `HTTP Error 403` (shared helpers exist). Only
  URL sources; an uploaded file (sourceKey) never flap-waits.
- Mechanism: the worker processor hands the BullMQ job handle + token into the
  download stage. On a flap failure with waits remaining:
  `job.updateData({...data, flapWaits: n+1})`, `job.moveToDelayed(now + DELAY[n], token)`,
  `throw DelayedError` - this consumes NO BullMQ attempt and fires NO failed
  event (so the queue-release hook correctly does not fire: the pipeline is
  alive). Delays: 10 min, 30 min, 90 min (three waits, ~2.2 h total - covers
  every observed episode). After the third, the failure falls through to the
  existing FAILED path (tagged copy, ledger settle by sweep, queue slot freed).
- The job keeps `status: DOWNLOADING` and its concurrency slot while parked -
  correct: the user's later videos queue behind it, and the 90-min gap is
  under the 3 h stall guard.
- Kill switch: `DOWNLOAD_FLAP_WAIT=off` disables (default ON - this is retry
  semantics, same class as the probe's 403 retry which shipped unflagged).
- v1 accepts: the progress board says "downloading" for up to 2.2 h. Honest
  enough; a "waiting out a block" board state is a later nicety.

## 2. Solution A (build SECOND - plausible benefit): GVS PO-token sidecar

The soft mode is yt-dlp's documented "GVS PO token required" symptom. The
maintained provider (bgutil-ytdlp-pot-provider v1.3.x) generates tokens via
BotGuard. Measured 2026-08-19: infrastructure works (provider registers,
`bgutil:http` listed), does NOT beat the hard mode (bot check on metadata) -
expected per upstream's own caution. Against the soft mode it is the designed
fix and untested here only because the exit flipped hard mid-test.

- compose service `potprovider` (pinned image, no published ports, compose
  network only, restart unless-stopped).
- `pip install bgutil-ytdlp-pot-provider` (pinned) in the three yt-dlp images
  (bot, worker, web) beside the existing pinned `yt-dlp[default]`.
- Shared helper `potArgs()` beside `proxyArgs()`: when `YTDLP_POT_PROVIDER_URL`
  is set, emit `--extractor-args youtubepot-bgutilhttp:base_url=<url>` on every
  yt-dlp invocation (probe + download). Unset = byte-identical behaviour; a
  down provider degrades to tokenless (plugin falls back).
- Env: `YTDLP_POT_PROVIDER_URL=http://potprovider:4416` in the live .env.

## 3. Also free, deliberately NOT built now

- Burner-account cookies pierce the hard mode (yt-dlp wiki path) but need a
  Google account the owner creates and periodically replaces after bans -
  owner's call, zero code until then.
- IPv6 exit + PO token in soft mode; ProtonVPN/Windscribe free tiers as a
  second egress class - measurement candidates for a quiet day.
- A second host's WARP remains the structural fix when a host exists.

## 4. Acceptance

B: unit tests with a mocked job handle - delay ladder order and values, data
counter, DelayedError thrown, no attempt consumed on flap, non-flap errors and
file sources unaffected, exhaustion falls through to the real failure;
mutation-checked. A: images build, probe works with the provider up AND with it
stopped; `bgutil:http` visible in `yt-dlp -v` output from inside a container.
