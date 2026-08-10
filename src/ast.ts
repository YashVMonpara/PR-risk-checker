import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Language, Parser, Query, Node } from 'web-tree-sitter';
import { StructuralChange } from './types';

export type SupportedLanguage = 'javascript' | 'typescript' | 'tsx';

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
};

/** Resolves the tree-sitter language for a file path, or null if unsupported. */
export function languageForPath(path: string): SupportedLanguage | null {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSION_MAP[base.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Candidate directories for the .wasm grammar files.
 *
 * In a built action everything sits next to dist/index.js. During tests and
 * local runs we fall back to the node_modules copies.
 */
function wasmSearchPaths(file: string): string[] {
  const roots = [join(__dirname, '..'), process.cwd()];
  const paths = [join(__dirname, file)];

  for (const root of roots) {
    paths.push(
      join(root, 'dist', file),
      // Grammar files ship in @vscode/tree-sitter-wasm ...
      join(root, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm', file),
      // ... while the runtime web-tree-sitter.wasm ships in web-tree-sitter itself.
      join(root, 'node_modules', 'web-tree-sitter', file)
    );
  }

  return paths;
}

function resolveWasm(file: string): string {
  for (const candidate of wasmSearchPaths(file)) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate ${file}. Searched: ${wasmSearchPaths(file).join(', ')}`);
}

let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedLanguage, Language>();
const parserCache = new Map<SupportedLanguage, Parser>();

/** Initialises the tree-sitter runtime exactly once per process. */
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: (path: string) => resolveWasm(path.split('/').pop() ?? path),
    } as never);
  }
  await initPromise;
}

async function getParser(language: SupportedLanguage): Promise<Parser> {
  await ensureInit();

  const cached = parserCache.get(language);
  if (cached) return cached;

  let lang = languageCache.get(language);
  if (!lang) {
    lang = await Language.load(readFileSync(resolveWasm(`tree-sitter-${language}.wasm`)));
    languageCache.set(language, lang);
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}

/** Releases cached parsers. Mainly used so Jest can exit cleanly. */
export function resetParsers(): void {
  for (const parser of parserCache.values()) parser.delete();
  parserCache.clear();
  languageCache.clear();
}

/** A function/method signature captured from one version of a file. */
interface SignatureInfo {
  name: string;
  params: string;
  exported: boolean;
  isMethod: boolean;
  line: number;
}

/** True when the node sits underneath an `export` statement. */
function isExported(node: Node): boolean {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === 'export_statement') return true;
    // Stop climbing once we leave the declaration's own wrappers.
    if (current.type === 'program') return false;
    current = current.parent;
  }
  return false;
}

const SIGNATURE_QUERY = `
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params) @fn

  (generator_function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params) @fn

  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function parameters: (formal_parameters) @params)
            (function_expression parameters: (formal_parameters) @params)]) @fn

  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params) @method
`;

/** Finds the enclosing class name for a method node, if any. */
function enclosingClassName(node: Node): string | null {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class') {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

/** Extracts every named function/method signature from a source file. */
function collectSignatures(source: string, parser: Parser, language: Language): SignatureInfo[] {
  const tree = parser.parse(source);
  if (!tree) return [];

  const signatures: SignatureInfo[] = [];

  try {
    const query = new Query(language, SIGNATURE_QUERY);

    for (const match of query.matches(tree.rootNode)) {
      const nameNode = match.captures.find((c) => c.name === 'name')?.node;
      const paramsNode = match.captures.find((c) => c.name === 'params')?.node;
      const anchor =
        match.captures.find((c) => c.name === 'fn')?.node ??
        match.captures.find((c) => c.name === 'method')?.node;

      if (!nameNode || !paramsNode || !anchor) continue;

      const isMethod = match.captures.some((c) => c.name === 'method');
      const className = isMethod ? enclosingClassName(anchor) : null;

      signatures.push({
        name: className ? `${className}.${nameNode.text}` : nameNode.text,
        params: paramsNode.text.replace(/\s+/g, ' ').trim(),
        exported: isMethod ? (className ? isExportedClass(anchor) : false) : isExported(anchor),
        isMethod,
        line: nameNode.startPosition.row + 1,
      });
    }

    query.delete();
  } finally {
    tree.delete();
  }

  return signatures;
}

/** True when a method's enclosing class is exported. */
function isExportedClass(node: Node): boolean {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class') {
      return isExported(current);
    }
    current = current.parent;
  }
  return false;
}

/**
 * Compares the base and head versions of a file and reports structural changes:
 * changed signatures, and added/removed exported symbols.
 *
 * Symbols are matched by name, so a rename reads as a removal plus an addition.
 * Returns an empty array for unsupported languages or unparseable input.
 */
export async function extractStructuralChanges(
  baseContent: string | null,
  headContent: string | null,
  filePath: string
): Promise<StructuralChange[]> {
  const language = languageForPath(filePath);
  if (!language) return [];
  if (baseContent === null && headContent === null) return [];

  let parser: Parser;
  let lang: Language;
  try {
    parser = await getParser(language);
    lang = languageCache.get(language)!;
  } catch (error) {
    // Infrastructure failure (missing WASM). Surface it — silently returning []
    // would disable AST analysis without anyone noticing.
    throw new Error(
      `tree-sitter initialisation failed for ${filePath}: ${(error as Error).message}`
    );
  }

  let baseSignatures: SignatureInfo[] = [];
  let headSignatures: SignatureInfo[] = [];

  try {
    baseSignatures = baseContent ? collectSignatures(baseContent, parser, lang) : [];
    headSignatures = headContent ? collectSignatures(headContent, parser, lang) : [];
  } catch {
    return [];
  }

  const changes: StructuralChange[] = [];
  const baseByName = new Map(baseSignatures.map((s) => [s.name, s]));
  const headByName = new Map(headSignatures.map((s) => [s.name, s]));

  for (const head of headSignatures) {
    const base = baseByName.get(head.name);

    if (!base) {
      changes.push({
        type: head.exported ? 'export_added' : 'function_added',
        name: head.name,
        exported: head.exported,
        after: head.params,
        line: head.line,
      });
      continue;
    }

    if (base.params !== head.params) {
      changes.push({
        type: head.isMethod ? 'method_changed' : 'signature_changed',
        name: head.name,
        exported: head.exported,
        before: base.params,
        after: head.params,
        line: head.line,
      });
    }
  }

  for (const base of baseSignatures) {
    if (!headByName.has(base.name)) {
      changes.push({
        type: base.exported ? 'export_removed' : 'function_removed',
        name: base.name,
        exported: base.exported,
        before: base.params,
      });
    }
  }

  return changes;
}
