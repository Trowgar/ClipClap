import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const worker = resolve(__dirname, "..");
const repositoryRoot = resolve(worker, "../../..");
const entrypoints = [resolve(worker, "scripts/feedback-learning-export.ts"), resolve(worker, "scripts/feedback-learning-review.ts")];
const mutationNames = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const rawNames = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRaw", "$queryRawUnsafe"]);

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function stringValue(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function importSpecifiers(sourceFile: ts.SourceFile): string[] {
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const value = stringValue(node.moduleSpecifier);
      if (value !== undefined) result.push(value);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const value = stringValue(node.moduleReference.expression);
      if (value !== undefined) result.push(value);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) {
        const value = stringValue(node.arguments[0]);
        if (value !== undefined) result.push(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

async function resolveLocalImport(from: string, specifier: string): Promise<string | undefined> {
  let base: string;
  if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else if (specifier === "@clipclap/shared") base = resolve(repositoryRoot, "packages/shared/src/index");
  else if (specifier.startsWith("@clipclap/shared/")) base = resolve(repositoryRoot, "packages/shared/src", specifier.slice("@clipclap/shared/".length));
  else return undefined;
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    try { await readFile(candidate, "utf8"); return candidate; } catch { /* Try the next local resolution. */ }
  }
  throw new Error(`unresolved_local_import:${specifier}`);
}

async function reachableSources(): Promise<ReadonlyMap<string, string>> {
  const pending = [...entrypoints];
  const sources = new Map<string, string>();
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (sources.has(path)) continue;
    const source = await readFile(path, "utf8");
    sources.set(path, source);
    for (const specifier of importSpecifiers(parse(path, source))) {
      const target = await resolveLocalImport(path, specifier);
      if (target !== undefined && !sources.has(target)) pending.push(target);
    }
  }
  return sources;
}

function accessedProperty(node: ts.Node): Readonly<{ receiver: ts.Expression; name: string }> | undefined {
  if (ts.isPropertyAccessExpression(node)) return { receiver: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node)) {
    const name = stringValue(node.argumentExpression);
    if (name !== undefined) return { receiver: node.expression, name };
  }
  return undefined;
}

function isAllowedNonDatabaseUse(access: Readonly<{ receiver: ts.Expression; name: string }>): boolean {
  if (access.name === "create" && access.receiver.getText() === "Object") return true;
  if (access.name === "delete" && (access.receiver.getText() === "Set.prototype" || access.receiver.getText() === "Map.prototype")) return true;
  return access.name === "update" && ts.isCallExpression(access.receiver) && ts.isIdentifier(access.receiver.expression) && access.receiver.expression.text === "createHash";
}

function isReadOnlyTransactionStatement(node: ts.Node, access: Readonly<{ receiver: ts.Expression; name: string }>): boolean {
  if (access.name !== "$executeRaw" && access.name !== "$executeRawUnsafe") return false;
  if (ts.isCallExpression(node.parent) && node.parent.expression === node && node.parent.arguments.length === 1) {
    return stringValue(node.parent.arguments[0]) === "SET TRANSACTION READ ONLY";
  }
  if (ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node) {
    return stringValue(node.parent.template) === "SET TRANSACTION READ ONLY";
  }
  return false;
}

function databaseBoundaryViolations(path: string, source: string): string[] {
  const sourceFile = parse(path, source);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    const access = accessedProperty(node);
    if (access !== undefined && mutationNames.has(access.name) && !isAllowedNonDatabaseUse(access)) violations.push(node.getText(sourceFile));
    if (access !== undefined && rawNames.has(access.name) && !isReadOnlyTransactionStatement(node, access)) violations.push(node.getText(sourceFile));
    if (ts.isElementAccessExpression(node) && stringValue(node.argumentExpression) === undefined &&
        ts.isCallExpression(node.parent) && node.parent.expression === node &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      violations.push(node.getText(sourceFile));
    }
    if (ts.isBindingElement(node)) {
      const name = node.propertyName === undefined ? node.name.getText(sourceFile) : node.propertyName.getText(sourceFile);
      if (mutationNames.has(name) || rawNames.has(name)) violations.push(node.getText(sourceFile));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (mutationNames.has(node.expression.text) || rawNames.has(node.expression.text))) violations.push(node.getText(sourceFile));
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && rawNames.has(node.tag.text)) violations.push(node.getText(sourceFile));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function loaderBoundaryViolations(path: string, source: string): string[] {
  const sourceFile = parse(path, source);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (node.arguments.length !== 1 || stringValue(node.arguments[0]) === undefined)) {
      violations.push(node.getText(sourceFile));
    }
    const access = accessedProperty(node);
    if (access !== undefined && (access.name === "createRequire" || access.name === "require")) {
      violations.push(node.getText(sourceFile));
    }
    if (ts.isElementAccessExpression(node) && node.expression.getText(sourceFile) === "module" &&
        stringValue(node.argumentExpression) === undefined) violations.push(node.getText(sourceFile));
    if (ts.isIdentifier(node) && node.text === "createRequire") violations.push(node.getText(sourceFile));
    if (ts.isIdentifier(node) && node.text === "require") {
      const directLiteralCall = ts.isCallExpression(node.parent) && node.parent.expression === node &&
        node.parent.arguments.length === 1 && stringValue(node.parent.arguments[0]) !== undefined;
      const mainGuard = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === "main";
      if (!directLiteralCall && !mainGuard) violations.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe("feedback-learning dependency boundary", () => {
  it("walks every reachable feedback-learning source and rejects forbidden dependencies", async () => {
    const sources = await reachableSources();
    const feedbackDirectory = resolve(worker, "feedback-learning");
    const expected = (await readdir(feedbackDirectory)).filter((name) => name.endsWith(".ts")).sort();
    const reached = [...sources.keys()].filter((path) => dirname(path) === feedbackDirectory).map((path) => path.slice(feedbackDirectory.length + 1)).sort();
    expect(reached).toEqual(expected);
    expect(sources.has(resolve(repositoryRoot, "packages/shared/src/lib/prisma.ts"))).toBe(true);
    const specifiers = [...sources].flatMap(([path, source]) => importSpecifiers(parse(path, source)));
    expect(specifiers).not.toEqual(expect.arrayContaining([expect.stringMatching(/openai|aws-sdk|eval-record|analyze|download|ytdlp|r2|s3/i)]));
    expect(importSpecifiers(parse("require.ts", "require('openai'); import('@aws-sdk/client-s3')"))).toEqual(["openai", "@aws-sdk/client-s3"]);
  });

  it("rejects generic, bracket, destructured and raw database mutations", async () => {
    const sources = await reachableSources();
    expect([...sources].flatMap(([path, source]) => databaseBoundaryViolations(path, source))).toEqual([]);
    for (const forbidden of [
      "client.user.create({})",
      "client.user['delete']({})",
      "const { update: mutate } = client.user; mutate({})",
      "client.$queryRaw`SELECT 1`",
      "client['$executeRaw']('DELETE FROM users')",
      "const { $executeRaw: run } = client",
      "require('./mutation').client.user.upsert({})",
      "client.user[method]({})",
      "client.user['up' + 'date']({})",
    ]) expect(databaseBoundaryViolations("forbidden.ts", forbidden)).not.toEqual([]);
    expect(databaseBoundaryViolations("allowed.ts", "transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY'); Object.create(null); createHash('sha256').update(value)")).toEqual([]);
  });

  it("rejects unsupported dynamic and aliased module loaders", async () => {
    const sources = await reachableSources();
    expect([...sources].flatMap(([path, source]) => loaderBoundaryViolations(path, source))).toEqual([]);
    for (const forbidden of [
      "import(moduleName)",
      "require(moduleName)",
      "module.require('./private')",
      "module['require']('./private')",
      "module[loaderName]('./private')",
      "globalThis['require']('./private')",
      "const load = require; load('./private')",
      "import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url)",
      "const { createRequire: makeRequire } = require('node:module')",
    ]) expect(loaderBoundaryViolations("forbidden.ts", forbidden)).not.toEqual([]);
  });

  it("imports command modules without stdout, stderr, main invocation or eager fs-ext", async () => {
    vi.resetModules();
    const environmentKeys = Object.keys(process.env);
    const exitCode = process.exitCode;
    const fsExtBefore = Object.keys(require.cache).filter((path) => /[/\\]fs-ext[/\\]/.test(path));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await import("../scripts/feedback-learning-export");
      await import("../scripts/feedback-learning-review");
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
      expect(Object.keys(process.env)).toEqual(environmentKeys);
      expect(Object.keys(require.cache).filter((path) => /[/\\]fs-ext[/\\]/.test(path))).toEqual(fsExtBefore);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
