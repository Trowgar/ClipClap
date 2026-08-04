/**
 * Renders a fixture's clip set as real product output, so a human can watch it.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-render-set.ts <fixture> <sourceJobId> <ownerUserId>"
 *
 * A snapshot proves the engine is deterministic. It says nothing about whether
 * the clips are worth posting, and that question has been answered exactly once
 * in this project's life (engine-notes 5b). This script closes that gap: it
 * replays the fixture - free, the responses are on disk - and pushes the
 * resulting highlights through the SAME render stage the product runs, so the
 * thing being judged is the thing users receive, not an approximation of it.
 *
 * The source artifact and transcript are borrowed from the job the fixture was
 * recorded from; nothing about that job is modified. The new job is owned by
 * ownerUserId, which must be an internal account - it bills minutes like any
 * other job, and it must never be another user's id.
 *
 * sourceArtifactKey is set EQUAL to normalizedArtifactKey on purpose: the
 * retention sweep's redundant-copy rule has nothing to delete when they match,
 * so an eval job can never race the sweep for the borrowed artifact.
 */
import { getStageQueue, prisma } from "@clipclap/shared";
import type { Prisma } from "@prisma/client";
import { loadFixture, runFixture } from "../__tests__/helpers/eval-fixture";

async function main() {
  const [fixtureName, sourceJobId, ownerUserId] = process.argv.slice(2);
  if (!fixtureName || !sourceJobId || !ownerUserId) {
    console.error(
      "usage: eval-render-set.ts <fixture> <sourceJobId> <ownerUserId>"
    );
    process.exit(1);
  }

  const source = await prisma.job.findUniqueOrThrow({
    where: { id: sourceJobId },
    select: {
      normalizedArtifactKey: true,
      sourceArtifactKey: true,
      transcriptJson: true,
      transcriptPartial: true,
      language: true,
      languageRaw: true,
      sourceDurationSec: true,
      originalFilename: true,
    },
  });

  const artifactKey = source.normalizedArtifactKey ?? source.sourceArtifactKey;
  if (!artifactKey) {
    throw new Error(`job ${sourceJobId} has no artifact to render from`);
  }

  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerUserId },
    select: { id: true, plan: true },
  });

  const fixture = loadFixture(fixtureName);
  const result = await runFixture(fixture);
  if (result.highlights.length === 0) {
    throw new Error(`fixture ${fixtureName} replayed to zero highlights`);
  }

  const job = await prisma.job.create({
    data: {
      userId: owner.id,
      // Named so it is obvious in the dashboard and in any later cleanup that
      // this row is an instrument, not a customer's video.
      originalFilename: `[eval:${fixtureName}] ${source.originalFilename ?? sourceJobId}`,
      status: "ANALYZING",
      sourceArtifactKey: artifactKey,
      normalizedArtifactKey: artifactKey,
      sourceDurationSec: source.sourceDurationSec,
      transcriptJson: source.transcriptJson as Prisma.InputJsonValue,
      transcriptPartial: source.transcriptPartial,
      language: source.language,
      languageRaw: source.languageRaw,
      subtitles: true,
      analyzeEngine: "RECALL_CRITIC",
      highlightsVersion: 2,
      highlights: result.highlights as unknown as Prisma.InputJsonValue,
      noClipsReason: result.noClipsReason ?? null,
    },
    select: { id: true },
  });

  await getStageQueue("render").add("render", {
    jobId: job.id,
    userId: owner.id,
    mode: "clips",
  });

  console.log(`queued render for job ${job.id} (${result.highlights.length} clips)`);
  for (const h of result.highlights) {
    console.log(`  ${h.start.toFixed(1)}-${h.end.toFixed(1)} [${h.score ?? 0}] ${h.title}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
