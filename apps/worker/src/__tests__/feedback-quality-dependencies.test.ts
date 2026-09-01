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

type SemanticAliases = { prisma: Set<string>; r2: Set<string>; process: Set<string> };

function bindingName(name: ts.BindingName): string | undefined {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function semanticAliases(source: ts.SourceFile): SemanticAliases {
  const aliases = { prisma: new Set<string>(), r2: new Set<string>(), process: new Set<string>() };
  const addImport = (moduleName: string, name: string): void => {
    const target = moduleName.includes("/prisma") ? aliases.prisma : moduleName.includes("/r2") ? aliases.r2 : moduleName === "node:child_process" || moduleName === "child_process" ? aliases.process : undefined;
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
        const target = moduleName.includes("/prisma") ? aliases.prisma : moduleName.includes("/r2") ? aliases.r2 : moduleName === "node:child_process" || moduleName === "child_process" ? aliases.process : undefined;
        if (!target) continue;
        for (const property of element.name.elements) {
          const local = bindingName(property.name);
          if (local) target.add(local);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require" && node.initializer.arguments.length === 1) {
      const moduleName = moduleLiteral(node.initializer.arguments[0], "require");
      const kind = moduleKind(moduleName);
      const target = kind ? aliases[kind] : undefined;
      if (target) for (const element of node.name.elements) {
        const local = bindingName(element.name);
        if (local) target.add(local);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  propagateLocalAliases(source, aliases);
  return aliases;
}

function moduleKind(moduleName: string): keyof SemanticAliases | undefined {
  if (moduleName.includes("/prisma")) return "prisma";
  if (moduleName.includes("/r2")) return "r2";
  if (moduleName === "node:child_process" || moduleName === "child_process") return "process";
  return undefined;
}

function propagatedSemanticAliases(graph: ModuleGraph): Map<string, SemanticAliases> {
  const aliases = new Map<string, { prisma: Set<string>; r2: Set<string>; process: Set<string> }>();
  for (const [file, source] of graph) aliases.set(file, semanticAliases(source));
  for (let round = 0; round <= graph.size; round += 1) {
    let changed = false;
    for (const [file, source] of graph) {
      const local = aliases.get(file)!;
      if (propagateLocalAliases(source, local)) changed = true;
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) continue;
        const targetFile = resolveRelative(file, statement.moduleSpecifier.text);
        const target = targetFile ? aliases.get(targetFile) : undefined;
        if (!target) continue;
        if (statement.importClause?.name) {
          for (const kind of ["prisma", "r2", "process"] as const) if ((target[kind].has("default") || target[kind].has("*")) && !local[kind].has(statement.importClause.name.text)) { local[kind].add(statement.importClause.name.text); changed = true; }
        }
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          for (const kind of ["prisma", "r2", "process"] as const) if (target[kind].size > 0 && !local[kind].has(bindings.name.text)) { local[kind].add(bindings.name.text); changed = true; }
        }
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
          const imported = item.propertyName?.text ?? item.name.text;
          for (const kind of ["prisma", "r2", "process"] as const) if ((target[kind].has(imported) || target[kind].has("*")) && !local[kind].has(item.name.text)) { local[kind].add(item.name.text); changed = true; }
        }
      }
      for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement)) continue;
        const moduleName = statement.moduleSpecifier && (ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined);
        const target = moduleName?.startsWith(".") ? aliases.get(resolveRelative(file, moduleName) ?? "") : undefined;
        const externalKind = moduleName ? moduleKind(moduleName) : undefined;
        if (!statement.exportClause) {
          for (const kind of ["prisma", "r2", "process"] as const) {
            const tainted = externalKind === kind || (target?.[kind].size ?? 0) > 0;
            if (tainted && !local[kind].has("*")) { local[kind].add("*"); changed = true; }
          }
          continue;
        }
        if (ts.isNamespaceExport(statement.exportClause)) {
          for (const kind of ["prisma", "r2", "process"] as const) {
            const tainted = externalKind === kind || (target?.[kind].size ?? 0) > 0;
            if (tainted && !local[kind].has(statement.exportClause.name.text)) { local[kind].add(statement.exportClause.name.text); changed = true; }
          }
          continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const item of statement.exportClause.elements) {
          const imported = item.propertyName?.text ?? item.name.text;
          const exported = item.name.text;
          for (const kind of ["prisma", "r2", "process"] as const) {
            const tainted = externalKind === kind || target?.[kind].has(imported) || target?.[kind].has("*") || (!moduleName && (local[kind].has(imported) || local[kind].has("*")));
            if (tainted && !local[kind].has(exported)) { local[kind].add(exported); changed = true; }
          }
        }
      }
    }
    if (!changed) break;
  }
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

function propagateLocalAliases(source: ts.SourceFile, aliases: SemanticAliases): boolean {
  const callables = new Map<string, readonly ts.ParameterDeclaration[]>();
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) callables.set(node.name.text, node.parameters);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) callables.set(node.name.text, node.initializer.parameters);
    ts.forEachChild(node, collect);
  };
  collect(source);
  let anyChanged = false;
  for (let round = 0; round <= source.statements.length + callables.size; round += 1) {
    let changed = false;
    const addFrom = (target: string, expression: ts.Expression): void => {
      const base = receiverBase(expression);
      if (!base) return;
      for (const kind of ["prisma", "r2", "process"] as const) if (aliases[kind].has(base) && !aliases[kind].has(target)) {
        aliases[kind].add(target); changed = true; anyChanged = true;
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) addFrom(node.name.text, node.initializer);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) addFrom(node.left.text, node.right);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const parameters = callables.get(node.expression.text);
        if (parameters) for (let index = 0; index < Math.min(parameters.length, node.arguments.length); index += 1) {
          const parameter = parameters[index];
          if (ts.isIdentifier(parameter.name)) addFrom(parameter.name.text, node.arguments[index]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!changed) break;
  }
  return anyChanged;
}

function callsNamed(source: ts.SourceFile, names: ReadonlySet<string>, receiverPattern?: RegExp, aliases?: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && aliases?.has(node.expression.text) && (names.has(node.expression.text) || aliases.size > 0)) found.push(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression) && names.has(node.expression.name.text)) {
        const receiver = node.expression.expression.getText(source);
        const aliased = aliases?.has(receiverBase(node.expression.expression) ?? "") === true;
        if ((!receiverPattern || receiverPattern.test(receiver)) && (!aliases || aliased)) found.push(node.expression.name.text);
      }
      if (ts.isPropertyAccessExpression(node.expression) && aliases?.has(receiverBase(node.expression.expression) ?? "") && !names.has(node.expression.name.text)) found.push(node.expression.name.text);
      if (ts.isElementAccessExpression(node.expression) && aliases?.has(receiverBase(node.expression.expression) ?? "")) {
        const argument = node.expression.argumentExpression;
        const name = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : "<dynamic>";
        found.push(name);
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
  const aliases = propagatedSemanticAliases(graph);
  return [...graph.values()].flatMap((source) => {
    const localAliases = aliases.get(source.fileName)?.[kind] ?? new Set<string>();
    return callsNamed(source, names, undefined, localAliases);
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
    expect([...new Set(graphSemanticCalls(graph, mutators, "prisma"))]).toEqual(["$disconnect"]);
    const sourceText = [...graph.values()].map((source) => source.getFullText()).join("\n");
    const directPrismaCalls = [...sourceText.matchAll(/\bprisma\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
    expect([...new Set(directPrismaCalls)]).toEqual(["$disconnect"]);
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
    expect(graphSemanticCalls(graph, new Set(["spawn"]), "process")).toEqual([]);
  });

  it("keeps gate private-I/O-only while deployment owns BullMQ and process execution", async () => {
    const gate = await reachable(ENTRYPOINTS.gate);
    const gateImports = graphImports(gate);
    expect(gateImports.some((value) => value === "bullmq" || value === "@clipclap/shared/lib/redis")).toBe(false);
    expect(graphSemanticCalls(gate, new Set(["spawn"]), "process")).toEqual([]);
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

  it("taints renamed direct and namespace calls through local re-export wrappers", async () => {
    const root = await mkdtemp(resolve(SOURCE_ROOT, "../../../../tmp-feedback-quality-aliases-"));
    try {
      const entry = resolve(root, "entry.ts");
      await writeFile(resolve(root, "process-wrapper.ts"), 'import { spawn as localSpawn } from "node:child_process"; export { localSpawn as launch };\n');
      await writeFile(resolve(root, "r2-wrapper.ts"), 'export { putObject as write } from "@clipclap/shared/lib/r2";\n');
      await writeFile(resolve(root, "process-star.ts"), 'export * from "./process-wrapper";\n');
      await writeFile(resolve(root, "process-namespace.ts"), 'export * as childProcess from "./process-wrapper";\n');
      await writeFile(resolve(root, "process-default.ts"), 'import { spawn as localSpawn } from "node:child_process"; export { localSpawn as default };\n');
      await writeFile(resolve(root, "process-require.ts"), 'const { spawn: launch } = require("node:child_process"); export { launch };\n');
      await writeFile(resolve(root, "r2-renamed.ts"), 'export { write as renamed } from "./r2-wrapper";\n');
      await writeFile(resolve(root, "r2-star.ts"), 'export * from "./r2-wrapper";\n');
      await writeFile(resolve(root, "r2-namespace.ts"), 'export * as storage from "./r2-wrapper";\n');
      await writeFile(entry, 'import { launch } from "./process-wrapper"; import { launch as starLaunch } from "./process-star"; import { childProcess } from "./process-namespace"; import defaultLaunch from "./process-default"; import { launch as requireLaunch } from "./process-require"; import { write } from "./r2-wrapper"; import { renamed } from "./r2-renamed"; import { write as starWrite } from "./r2-star"; import { storage } from "./r2-namespace"; launch("cmd"); starLaunch("cmd"); childProcess.launch("cmd"); defaultLaunch("cmd"); requireLaunch("cmd"); write("key"); renamed("key"); starWrite("key"); storage.write("key");\n');
      const graph = await reachable(entry);
      expect(graphSemanticCalls(graph, new Set(["spawn"]), "process")).toContain("launch");
      expect(graphSemanticCalls(graph, new Set(["spawn"]), "process")).toContain("starLaunch");
      expect(graphSemanticCalls(graph, new Set(["spawn"]), "process")).toContain("defaultLaunch");
      expect(graphSemanticCalls(graph, new Set(["spawn"]), "process")).toContain("requireLaunch");
      expect(graphSemanticCalls(graph, new Set(["putObject"]), "r2")).toContain("write");
      expect(graphSemanticCalls(graph, new Set(["putObject"]), "r2")).toContain("renamed");
      expect(graphSemanticCalls(graph, new Set(["putObject"]), "r2")).toContain("starWrite");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("taints local Prisma aliases, bracket calls, and dynamic method access", async () => {
    const root = await mkdtemp(resolve(SOURCE_ROOT, "../../../../tmp-feedback-quality-prisma-aliases-"));
    try {
      const entry = resolve(root, "entry.ts");
      await writeFile(entry, 'import { prisma } from "@clipclap/shared/lib/prisma"; const p = prisma; p.create({}); prisma["update"]({}); const method = "delete"; prisma[method]({}); let assigned: typeof prisma; assigned = prisma; assigned.delete({}); function write(client: typeof prisma) { client.upsert({}); } write(prisma);\n');
      const graph = await reachable(entry);
      const calls = graphSemanticCalls(graph, new Set(["create", "update", "delete", "upsert"]), "prisma");
      expect(calls).toEqual(expect.arrayContaining(["create", "update", "<dynamic>", "delete", "upsert"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
