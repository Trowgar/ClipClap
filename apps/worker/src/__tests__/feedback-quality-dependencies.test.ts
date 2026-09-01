import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function moduleLiteral(node: ts.Node | undefined, context: string): string {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  throw new Error(`nonliteral_module_specifier:${context}`);
}

function literalModuleSpecifiers(source: ts.SourceFile): string[] {
  const result: string[] = [];
  const add = (node: ts.Node | undefined, context: string): void => { result.push(moduleLiteral(node, context)); };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) add(statement.moduleSpecifier, "import");
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) add(statement.moduleSpecifier, "export");
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) add(statement.moduleReference.expression, "import_equals");
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) add(argument.literal, "import_type");
      else throw new Error("nonliteral_module_specifier:import_type");
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      if (node.arguments.length !== 1) throw new Error("nonliteral_module_specifier:call_arity");
      add(node.arguments[0], node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic_import" : "require");
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

type SemanticAliases = Readonly<{ prisma: ReadonlySet<string>; r2: ReadonlySet<string> }>;

function bindingName(name: ts.BindingName): string | undefined {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function semanticAliases(source: ts.SourceFile): { prisma: Set<string>; r2: Set<string> } {
  const aliases = { prisma: new Set<string>(), r2: new Set<string>() };
  const addImport = (moduleName: string, name: string): void => {
    const target = moduleName.includes("/prisma") ? aliases.prisma : moduleName.includes("/r2") ? aliases.r2 : undefined;
    if (target) target.add(name);
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (statement.importClause?.name) addImport(moduleName, statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) addImport(moduleName, bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) addImport(moduleName, item.name.text);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) {
      const imports = [...node.initializer ? collectImportLiterals(node.initializer) : []];
      for (let index = 0; index < node.name.elements.length; index += 1) {
        const element = node.name.elements[index];
        const moduleName = imports[index];
        if (!element || !moduleName || !ts.isBindingElement(element) || !ts.isObjectBindingPattern(element.name)) continue;
        const target = moduleName.includes("/prisma") ? aliases.prisma : moduleName.includes("/r2") ? aliases.r2 : undefined;
        if (!target) continue;
        for (const property of element.name.elements) {
          const local = bindingName(property.name);
          if (local) target.add(local);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return aliases;
}

function collectImportLiterals(node: ts.Node): string[] {
  const result: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword && child.arguments.length === 1) {
      result.push(moduleLiteral(child.arguments[0], "dynamic_import"));
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}

function receiverBase(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return receiverBase(node.expression);
  if (ts.isElementAccessExpression(node)) return receiverBase(node.expression);
  return undefined;
}

function callsNamed(source: ts.SourceFile, names: ReadonlySet<string>, receiverPattern?: RegExp, aliases?: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && names.has(node.expression.text) && aliases?.has(node.expression.text)) found.push(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression) && names.has(node.expression.name.text)) {
        const receiver = node.expression.expression.getText(source);
        const aliased = aliases?.has(receiverBase(node.expression.expression) ?? "") === true;
        if ((!receiverPattern || receiverPattern.test(receiver)) && (!aliases || aliased)) found.push(node.expression.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function graphImports(graph: ModuleGraph): string[] {
  return [...graph.values()].flatMap(literalModuleSpecifiers);
}

function graphSemanticCalls(graph: ModuleGraph, names: ReadonlySet<string>, kind: keyof SemanticAliases): string[] {
  return [...graph.values()].flatMap((source) => {
    const aliases = semanticAliases(source)[kind];
    return callsNamed(source, names, undefined, aliases);
  });
}

describe("feedback quality dependency boundaries", () => {
  it("walks promotion's complete graph and permits only read Prisma/R2 edges", async () => {
    const graph = await reachable(ENTRYPOINTS.promotion);
    const imports = graphImports(graph);
    expect(imports).toContain("@clipclap/shared/lib/prisma");
    expect(imports).toContain("@clipclap/shared/lib/r2");
    expect(imports.some((value) => value === "bullmq" || value === "node:child_process")).toBe(false);
    const mutators = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
    expect(graphSemanticCalls(graph, mutators, "prisma")).toEqual([]);
    const sourceText = [...graph.values()].map((source) => source.getFullText()).join("\n");
    expect(sourceText).toContain("downloadFile");
    expect(sourceText).toContain("getObjectSize");
    expect(graphSemanticCalls(graph, new Set(["putObject", "deleteObject", "upload"]), "r2")).toEqual([]);
  });

  it("walks observation's complete graph, including analyzers/renderers, without DB/R2/queue/spawn", async () => {
    const graph = await reachable(ENTRYPOINTS.observation);
    const imports = graphImports(graph);
    expect(imports.some((value) => value.endsWith("/analyze-v2"))).toBe(true);
    expect(imports.some((value) => value.endsWith("/render-lane"))).toBe(true);
    expect(imports.some((value) => value.includes("@clipclap/shared/lib/prisma") || value.includes("@clipclap/shared/lib/r2") || value === "bullmq")).toBe(false);
    expect(imports).toContain("node:child_process"); // bounded ffmpeg/ffprobe probes only.
    expect([...graph.values()].flatMap((source) => callsNamed(source, new Set(["spawn"]), undefined, new Set(["spawn"])))).toEqual([]);
  });

  it("keeps gate private-I/O-only while deployment owns BullMQ and process execution", async () => {
    const gate = await reachable(ENTRYPOINTS.gate);
    const gateImports = graphImports(gate);
    expect(gateImports.some((value) => value === "bullmq" || value === "@clipclap/shared/lib/redis")).toBe(false);
    expect([...gate.values()].flatMap((source) => callsNamed(source, new Set(["spawn"]), undefined, new Set(["spawn"])))).toEqual([]);
    const deployment = await reachable(ENTRYPOINTS.deployment);
    const deploymentImports = graphImports(deployment);
    expect(deploymentImports).toContain("bullmq");
    expect(deploymentImports).toContain("node:child_process");
  });

  it("fails closed for nonliteral module edges and includes import-type literals", async () => {
    const root = await mkdtemp(resolve(SOURCE_ROOT, "../../../../tmp-feedback-quality-deps-"));
    try {
      const entry = resolve(root, "entry.ts");
      await writeFile(resolve(root, "dep.ts"), "export type Value = string;\n");
      await writeFile(entry, "type Value = import('./dep').Value;\nconst spec = './dep';\nvoid import(spec);\n");
      await expect(reachable(entry)).rejects.toThrow("nonliteral_module_specifier:dynamic_import");
      await writeFile(entry, "const spec = './dep';\nvoid require(spec);\n");
      await expect(reachable(entry)).rejects.toThrow("nonliteral_module_specifier:require");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
