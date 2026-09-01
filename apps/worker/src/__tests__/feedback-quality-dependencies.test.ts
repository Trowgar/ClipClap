import { readFile } from "node:fs/promises";
import { accessSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(__dirname, "..");
const ENTRYPOINTS = {
  promotion: resolve(SOURCE_ROOT, "scripts/feedback-quality-promote.ts"),
  observation: resolve(SOURCE_ROOT, "scripts/feedback-quality-observe.ts"),
  gate: resolve(SOURCE_ROOT, "feedback-quality/gate.ts"),
  deployment: resolve(SOURCE_ROOT, "feedback-quality/deploy.ts"),
} as const;

type ModuleGraph = Map<string, ts.SourceFile>;

function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts")]) {
    try {
      accessSync(candidate);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* try the next explicit source candidate */ }
  }
  return undefined;
}

function literalModuleSpecifiers(source: ts.SourceFile): string[] {
  const result: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteral(node)) result.push(node.text);
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) add(statement.moduleSpecifier);
    if (ts.isExportDeclaration(statement)) add(statement.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) add(statement.moduleReference.expression);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

async function reachable(entry: string): Promise<ModuleGraph> {
  const graph: ModuleGraph = new Map();
  const visit = async (file: string): Promise<void> => {
    if (graph.has(file)) return;
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    graph.set(file, source);
    for (const specifier of literalModuleSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const child = resolveRelative(file, specifier);
      if (!child) throw new Error(`unresolved_relative_import:${file}:${specifier}`);
      await visit(child);
    }
  };
  await visit(entry);
  return graph;
}

function callsNamed(source: ts.SourceFile, names: ReadonlySet<string>, receiverPattern?: RegExp): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && names.has(node.expression.name.text)) {
      const receiver = node.expression.expression.getText(source);
      if (!receiverPattern || receiverPattern.test(receiver)) found.push(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function graphImports(graph: ModuleGraph): string[] {
  return [...graph.values()].flatMap(literalModuleSpecifiers);
}

describe("feedback quality dependency boundaries", () => {
  it("walks promotion's complete graph and permits only read Prisma/R2 edges", async () => {
    const graph = await reachable(ENTRYPOINTS.promotion);
    const imports = graphImports(graph);
    expect(imports).toContain("@clipclap/shared/lib/prisma");
    expect(imports).toContain("@clipclap/shared/lib/r2");
    expect(imports.some((value) => value === "bullmq" || value === "node:child_process")).toBe(false);
    const mutators = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
    expect([...graph.values()].flatMap((source) => callsNamed(source, mutators, /\b(?:transaction|tx|prisma|client)\b/))).toEqual([]);
    const sourceText = [...graph.values()].map((source) => source.getFullText()).join("\n");
    expect(sourceText).toContain("downloadFile");
    expect(sourceText).toContain("getObjectSize");
    expect([...graph.values()].flatMap((source) => callsNamed(source, new Set(["putObject", "deleteObject", "upload"]), /(?:^|\.)(?:bucket|r2|object|client)$/))).toEqual([]);
  });

  it("walks observation's complete graph, including analyzers/renderers, without DB/R2/queue/spawn", async () => {
    const graph = await reachable(ENTRYPOINTS.observation);
    const imports = graphImports(graph);
    expect(imports.some((value) => value.endsWith("/analyze-v2"))).toBe(true);
    expect(imports.some((value) => value.endsWith("/render-lane"))).toBe(true);
    expect(imports.some((value) => value.includes("@clipclap/shared/lib/prisma") || value.includes("@clipclap/shared/lib/r2") || value === "bullmq")).toBe(false);
    expect(imports).toContain("node:child_process"); // bounded ffmpeg/ffprobe probes only.
    expect([...graph.values()].flatMap((source) => callsNamed(source, new Set(["spawn"])))).toEqual([]);
  });

  it("keeps gate private-I/O-only while deployment owns BullMQ and process execution", async () => {
    const gate = await reachable(ENTRYPOINTS.gate);
    const gateImports = graphImports(gate);
    expect(gateImports.some((value) => value === "bullmq" || value === "@clipclap/shared/lib/redis")).toBe(false);
    expect([...gate.values()].flatMap((source) => callsNamed(source, new Set(["spawn"])))).toEqual([]);
    const deployment = await reachable(ENTRYPOINTS.deployment);
    const deploymentImports = graphImports(deployment);
    expect(deploymentImports).toContain("bullmq");
    expect(deploymentImports).toContain("node:child_process");
  });
});
