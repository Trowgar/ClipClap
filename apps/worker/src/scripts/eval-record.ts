/**
 * Records an eval fixture from a real job.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-record.ts <jobId> <case-name>"
 *
 * Writes apps/worker/src/__tests__/fixtures/eval/<case-name>/{transcript,responses,snapshot}.json
 * Costs real API calls - run it deliberately, not in a loop.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { prisma } from "@clipclap/shared";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { requestKey } from "../__tests__/helpers/replay-client";
import { toShape } from "../__tests__/helpers/eval-fixture";

async function main() {
  const [jobId, caseName] = process.argv.slice(2);
  if (!jobId || !caseName) {
    console.error("usage: eval-record.ts <jobId> <case-name>");
    process.exit(1);
  }

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { transcriptJson: true, transcriptPartial: true },
  });
  const transcript = job.transcriptJson as never;

  const real = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const responses: Record<string, string> = {};
  const client = {
    chat: {
      completions: {
        create: async (body: {
          model: string;
          messages: Array<{ role: string; content: string }>;
        }) => {
          const response = await real.chat.completions.create(body as never);
          const completion = response as {
            choices: Array<{
              message: { content: string | null; refusal?: string | null };
              finish_reason?: string;
            }>;
          };
          const choice = completion.choices[0];
          const content = choice?.message?.content;
          const key = requestKey({
            model: body.model,
            system: body.messages.find((m) => m.role === "system")?.content ?? "",
            user: body.messages.find((m) => m.role === "user")?.content ?? "",
          });
          // Non-content outcomes are load-bearing: the critic splits a batch on
          // `truncated` and retries on `refusal`. Recording only content made
          // those calls vanish from the fixture, so replay died on an unrecorded
          // request instead of reproducing the recorded run.
          if (choice?.message?.refusal) {
            responses[key] = JSON.stringify({ __outcome: "refusal" });
          } else if (choice?.finish_reason === "length" || !content) {
            responses[key] = JSON.stringify({ __outcome: "truncated" });
          } else {
            responses[key] = content;
          }
          return response;
        },
      },
    },
  } as unknown as OpenAI;

  const result = await analyzeHighlightsV2(transcript, {
    client,
    cfg: { ...loadAnalyzeConfig(), engine: "recall-critic" },
    transcriptPartial: job.transcriptPartial ?? false,
  });

  const dir = join(__dirname, "..", "__tests__", "fixtures", "eval", caseName);
  mkdirSync(dir, { recursive: true });
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  write("transcript.json", transcript);
  write("responses.json", responses);
  write("snapshot.json", toShape(result));

  console.log(
    `recorded ${caseName}: ${Object.keys(responses).length} responses, ${result.highlights.length} clips`
  );
  for (const h of result.highlights) {
    console.log(`  ${h.start.toFixed(1)}-${h.end.toFixed(1)} [${h.score}] ${h.title}`);
  }
  process.exit(0);
}

main();
