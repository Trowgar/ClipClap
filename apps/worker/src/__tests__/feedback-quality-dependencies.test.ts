import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const ENTRYPOINTS = {
  promotion: resolve(ROOT, "scripts/feedback-quality-promote.ts"),
  observation: resolve(ROOT, "scripts/feedback-quality-observe.ts"),
  gate: resolve(ROOT, "feedback-quality/gate.ts"),
  deployment: resolve(ROOT, "feedback-quality/deploy.ts"),
} as const;

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts")]) {
    try {
      // Resolution is intentionally based on the checked-in source graph.
      require("node:fs").accessSync(candidate);
      if (require("node:fs").statSync(candidate).isFile()) return candidate;
    } catch { /* try the next source suffix */ }
  }
  return undefined;
}

async function reachable(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    const source = await readFile(file, "utf8");
    seen.set(file, source);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const child = resolveImport(file, statement.moduleSpecifier.text);
      if (child) await visit(child);
    }
  };
  await visit(entry);
  return seen;
}

function importSpecifiers(source: string): string[] {
  const ast = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const direct = ast.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [],
  );
  const dynamic: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) dynamic.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...direct, ...dynamic];
}

describe("feedback quality dependency boundaries", () => {
  it("keeps promotion read-only at Prisma/R2 edges and excludes queue/process deployment effects", async () => {
    const graph = await reachable(ENTRYPOINTS.promotion);
    const imports = [...graph.values()].flatMap(importSpecifiers);
    expect(imports).toContain("@clipclap/shared/lib/prisma");
    expect(imports).toContain("@clipclap/shared/lib/r2");
    expect(imports.some((value) => value === "bullmq" || value === "node:child_process")).toBe(false);
    const repository = await readFile(resolve(ROOT, "feedback-quality/repository.ts"), "utf8");
    expect(repository).toContain("SET TRANSACTION READ ONLY");
    expect(repository).not.toMatch(/\.(?:create|update|delete|upsert|createMany|updateMany|deleteMany)\s*\(/);
    const source = [...graph.values()].join("\n");
    expect(source).toContain("downloadFile");
    expect(source).toContain("getObjectSize");
    expect(source).not.toMatch(/\b(?:putObject|deleteObject|upload)\s*\(/);
  });

  it("allows observation analysis/render adapters but no database, R2, queue, or spawn imports", async () => {
    const graph = await reachable(ENTRYPOINTS.observation);
    const imports = [...graph.values()].flatMap(importSpecifiers);
    expect(imports.some((value) => value.endsWith("/analyze-v2") || value === "../analyze-v2")).toBe(true);
    expect(imports.some((value) => value.endsWith("/render-lane") || value === "./render-lane")).toBe(true);
    expect(imports.some((value) => value.includes("@clipclap/shared/lib/prisma"))).toBe(false);
    expect(imports.some((value) => value.includes("@clipclap/shared/lib/r2"))).toBe(false);
    expect(imports.some((value) => value === "bullmq")).toBe(false);
    expect(imports.some((value) => value === "node:child_process")).toBe(true); // ffmpeg/ffprobe probes are permitted.
    const source = [...graph.values()].join("\n");
    expect(source).not.toMatch(/\bspawn\s*\(/);
  });

  it("keeps gate private-I/O-only and makes deploy the sole queue/process boundary", async () => {
    const gateSource = await readFile(ENTRYPOINTS.gate, "utf8");
    const gateImports = importSpecifiers(gateSource);
    expect(gateImports.some((value) => value === "bullmq" || value === "node:child_process")).toBe(false);
    const deploy = await reachable(ENTRYPOINTS.deployment);
    const deployImports = [...deploy.values()].flatMap(importSpecifiers);
    expect(deployImports).toContain("bullmq");
    expect(deployImports).toContain("node:child_process");
    expect(extname(ENTRYPOINTS.gate)).toBe(".ts");
  });
});
