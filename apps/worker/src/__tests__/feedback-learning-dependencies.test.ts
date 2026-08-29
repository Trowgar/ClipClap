import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const worker = resolve(__dirname, "..");

describe("feedback-learning dependency boundary", () => {
  it("keeps commands free of OpenAI, R2, eval, analyze and download dependencies", async () => {
    const paths = [
      "feedback-learning/cli.ts",
      "feedback-learning/export.ts",
      "feedback-learning/review.ts",
      "feedback-learning/repository.ts",
      "scripts/feedback-learning-export.ts",
      "scripts/feedback-learning-review.ts",
    ];
    const source = (await Promise.all(paths.map((path) => readFile(resolve(worker, path), "utf8")))).join("\n");
    expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(openai|aws-sdk|eval-record|analyze|download|ytdlp|r2|s3)[^"']*["']/i);
  });

  it("repository reaches only read operations inside read-only transactions", async () => {
    const source = await readFile(resolve(worker, "feedback-learning/repository.ts"), "utf8");
    expect(source).toContain("SET TRANSACTION READ ONLY");
    expect(source).toContain("RepeatableRead");
    expect(source).not.toMatch(/transaction\.(clipFeedback|job)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\$(executeRaw|queryRaw)Unsafe\((?!"SET TRANSACTION READ ONLY")/);
  });

  it("imports command modules without eagerly loading fs-ext or running main", async () => {
    const before = Object.entries(process.env);
    const fsExtBefore = Object.keys(require.cache).filter((path) => /[/\\]fs-ext[/\\]/.test(path));
    await import("../scripts/feedback-learning-export");
    await import("../scripts/feedback-learning-review");
    expect(Object.entries(process.env)).toEqual(before);
    expect(Object.keys(require.cache).filter((path) => /[/\\]fs-ext[/\\]/.test(path))).toEqual(fsExtBefore);
  });
});
