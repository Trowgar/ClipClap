/**
 * Measures how many output tokens a critic batch really needs on a given model.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/measure-critic-budget.ts gpt-5.6-luna"
 *
 * Add --dry-run to recover the prompts and print what WOULD be measured without
 * spending a cent. Always do that first on a new fixture.
 *
 * Reproduces the method behind the table in critic.ts: take real critic prompts
 * from a fixture, run each batch size against a ladder of caps, and record
 * completion / reasoning / verdict counts. The budget for a batch size is then
 * the smallest round number ABOVE a cap that was OBSERVED TO COMPLETE at that
 * size - not a number derived from an average, because the model expands its
 * reasoning into whatever room it is given.
 *
 * Costs real API calls. On Luna the whole ladder is a few cents; on gpt-5.1 it
 * is not. Run it deliberately.
 */
import OpenAI from "openai";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { CRITIC_SCHEMA } from "../analyze-v2/schemas";
import { loadFixture, variantConfig } from "../__tests__/helpers/eval-fixture";
import { requestKey } from "../__tests__/helpers/replay-client";

const CAPS_BY_SIZE: Record<number, number[]> = {
  1: [400, 1200, 2000, 3000],
  3: [1200, 3000, 3600, 6000],
  6: [2400, 5000, 6000, 9000, 14000],
};

/**
 * Both eval fixtures by default, because no single one carries all three batch
 * sizes: podcast-ecology's critic calls are 6,6,6,6,1 and podcast-answer-arc's
 * are 6,6,6,6,3. Pooling them is what makes every measured row a REAL prompt
 * rather than a stand-in - see pickPrompt for what happens when it is not.
 */
const DEFAULT_FIXTURES = ["podcast-ecology", "podcast-answer-arc"];

/** How a row's prompt was obtained. Printed, because it changes what the row means. */
type PromptOrigin = "recorded" | "prefix";

interface RecordedPrompt {
  fixture: string;
  system: string;
  user: string;
  batchSize: number;
}

/** The separator criticUserPrompt() joins candidate blocks with. */
const BLOCK_SEP = "\n\n---\n\n";

/** Candidate blocks in a critic user prompt. Counted from the PROMPT, not from
 *  the recorded answer: the answer holds one row per verdict the model chose to
 *  return, which is <= the batch size whenever it omitted one, and an omission
 *  would silently relabel the row as a smaller batch than was actually sent. */
function countCandidateBlocks(user: string): number {
  return (user.match(/^CANDIDATE /gm) ?? []).length;
}

/**
 * Recovers the critic prompts from a fixture's recordings by replaying the
 * engine against them and capturing what it asks. The prompts are the honest
 * input: a hand-written one would measure a different workload than production.
 */
async function collectCriticPrompts(
  fixtureName: string,
  misses: string[]
): Promise<RecordedPrompt[]> {
  const fixture = loadFixture(fixtureName);
  const prompts: RecordedPrompt[] = [];
  const cfg = variantConfig("base");
  const client = {
    chat: {
      completions: {
        create: async (body: {
          model: string;
          messages: Array<{ role: string; content: string }>;
        }) => {
          const system = body.messages.find((m) => m.role === "system")?.content ?? "";
          const user = body.messages.find((m) => m.role === "user")?.content ?? "";
          const recorded = fixture.responses[requestKey({ model: body.model, system, user })];
          // A miss means the fixture is stale for this prompt. The engine would
          // absorb it as a dead window and still finish, so it has to be
          // surfaced here or a half-recovered prompt set looks complete.
          if (recorded === undefined) {
            misses.push(`${fixtureName}:${requestKey({ model: body.model, system, user })}`);
          }
          // Critic prompts are the ones addressing CANDIDATE blocks; the
          // scanner sends a transcript slice and the finalizer sends CLIP blocks.
          const batchSize = countCandidateBlocks(user);
          if (batchSize > 0 && recorded?.includes('"results"')) {
            prompts.push({ fixture: fixtureName, system, user, batchSize });
          }
          const outcome = recorded?.includes("__outcome") ?? false;
          return {
            choices: [
              {
                message: { content: outcome ? null : (recorded ?? "{}"), refusal: null },
                finish_reason: outcome ? "length" : "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          };
        },
      },
    },
  } as unknown as OpenAI;
  await analyzeHighlightsV2(fixture.transcript, { client, cfg, retryDelayMs: 1 });
  return prompts;
}

/**
 * Picks the prompt to measure a given batch size with.
 *
 * A recorded prompt of exactly that size is the only honest input. Failing that,
 * the first N blocks of a LARGER recorded prompt is not a fabrication either: a
 * critic batch that truncates is split in half and re-sent, and split() rebuilds
 * the user prompt from a slice of the same candidate list, so the first-N prefix
 * is byte-identical to a request the engine really makes. It is still labelled,
 * because it is a different candidate mix than a real tail batch of that size.
 *
 * What must never happen is the plan's `?? prompts[0]` fallback: that measures
 * some other batch size entirely and prints it under this size's label.
 */
function pickPrompt(
  prompts: RecordedPrompt[],
  size: number
): { prompt: RecordedPrompt; origin: PromptOrigin } | null {
  const exact = prompts.find((p) => p.batchSize === size);
  if (exact) return { prompt: exact, origin: "recorded" };
  const larger = prompts
    .filter((p) => p.batchSize > size)
    .sort((a, b) => a.batchSize - b.batchSize)[0];
  if (!larger) return null;
  const blocks = larger.user.split(BLOCK_SEP);
  if (blocks.length !== larger.batchSize) return null;
  return {
    prompt: {
      fixture: larger.fixture,
      system: larger.system,
      user: blocks.slice(0, size).join(BLOCK_SEP),
      batchSize: size,
    },
    origin: "prefix",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const model = positional[0];
  const fixtureNames = positional[1] ? positional[1].split(",") : DEFAULT_FIXTURES;
  if (!model && !dryRun) {
    console.error("usage: measure-critic-budget.ts <model> [fixture,fixture] [--dry-run]");
    process.exit(1);
  }

  const misses: string[] = [];
  const prompts: RecordedPrompt[] = [];
  for (const name of fixtureNames) {
    prompts.push(...(await collectCriticPrompts(name, misses)));
  }
  if (prompts.length === 0) {
    console.error(`no critic prompts recovered from ${fixtureNames.join(", ")}`);
    process.exit(1);
  }
  if (misses.length > 0) {
    console.warn(
      `WARNING: ${misses.length} unrecorded request(s) during replay - the fixture may be ` +
        `stale and the recovered prompt set incomplete: ${[...new Set(misses)].join(", ")}`
    );
  }
  console.log(
    `recovered ${prompts.length} critic prompt(s) from ${fixtureNames.join(", ")}: ` +
      prompts.map((p) => `${p.fixture}/${p.batchSize}`).join(" ")
  );

  const plan = Object.keys(CAPS_BY_SIZE)
    .map(Number)
    .sort((a, b) => a - b)
    .map((size) => ({ size, picked: pickPrompt(prompts, size) }));
  for (const { size, picked } of plan) {
    if (!picked) {
      console.log(`  size ${size}: NO PROMPT AVAILABLE - rows will be skipped`);
    } else {
      console.log(
        `  size ${size}: ${picked.origin} (${picked.prompt.fixture}, ` +
          `${picked.prompt.user.length} chars)`
      );
    }
  }

  if (dryRun) {
    const calls = plan.reduce(
      (n, { size, picked }) => n + (picked ? CAPS_BY_SIZE[size].length : 0),
      0
    );
    console.log(`\ndry run: would make ${calls} live call(s) against "${model ?? "<no model>"}"`);
    process.exit(0);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`\nmodel: ${model}`);
  console.log("batch /    cap ->  input / completion / reasoning / verdicts");

  for (const { size, picked } of plan) {
    if (!picked) continue;
    for (const cap of CAPS_BY_SIZE[size]) {
      const response = (await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: picked.prompt.system },
          { role: "user", content: picked.prompt.user },
        ],
        response_format: { type: "json_schema", json_schema: CRITIC_SCHEMA as never },
        max_completion_tokens: cap,
        reasoning_effort: "low",
      } as never)) as {
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
        choices: Array<{ message: { content: string | null }; finish_reason?: string }>;
      };
      const input = response.usage?.prompt_tokens ?? 0;
      const completion = response.usage?.completion_tokens ?? 0;
      const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const content = response.choices[0]?.message?.content;
      let verdicts = 0;
      if (content) {
        try {
          verdicts = (JSON.parse(content) as { results?: unknown[] }).results?.length ?? 0;
        } catch {
          verdicts = 0;
        }
      }
      const truncated = response.choices[0]?.finish_reason === "length" || !content;
      console.log(
        `  ${String(size).padStart(2)} / ${String(cap).padStart(6)} -> ` +
          `${String(input).padStart(6)} / ${String(completion).padStart(10)} / ` +
          `${String(reasoning).padStart(9)} / ${verdicts}` +
          (truncated ? "   (truncated)" : "") +
          (picked.origin === "prefix" ? "   [prefix prompt]" : "")
      );
    }
  }
  process.exit(0);
}

main();
