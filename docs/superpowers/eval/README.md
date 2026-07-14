# Highlight V2 offline eval

Gate table lives in the spec (docs/superpowers/specs/2026-07-13-highlight-core-recall-judge-design.md section 11).

## Building the labeled set (~80 sources)
25 podcasts, 20 streams, 10 gaming VODs, 10 short/weak videos (expect 0 clips),
10 multilingual/music-heavy, 5 long (2-3h) including yt-dlp merges with known A/V offset.

1. Run each source through the pipeline once (shadow mode is fine) so Job.transcriptJson exists.
2. Dump transcriptJson to eval/transcripts/<id>.json (prisma studio, or a psql SELECT).
3. Watch the source; mark strong moments with acceptable start/end (seconds) and the payoff second.
4. Add a manifest entry (format documented in apps/worker/src/scripts/eval-highlights.ts).

## Running
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-highlights.ts /app/eval/manifest.json"

Recall here is measured against SHIPPED clips (end-to-end). Scanner-level recall
can be read from the per-job telemetry (JobStep ANALYZE outputJson) in shadow mode.
Precision is human judgment: review shipped clips per case before ramping.
Each full run makes real OpenAI calls (about $0.05-0.15 per source hour) - budget accordingly.
