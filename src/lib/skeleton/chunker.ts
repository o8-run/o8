/**
 * Skeleton Map — AST-aware chunker using TypeScript Compiler API.
 *
 * Extracts complete structural code chunks (full function bodies, class bodies,
 * type definitions) with exact line/byte ranges. Each chunk is a self-contained
 * unit suitable for vector embedding.
 *
 * Uses ts.createSourceFile (parse-only, no type checking) — ~1-5ms per file.
 * TypeScript module is lazy-loaded to avoid the ~50MB startup cost.
 */

import { readFileSync } from 'node:fs';
import { loadTypeScriptCompiler } from '@/lib/typescript-compiler';
import { hashContent } from './parser';
import type { CodeChunk, FileChunks, SupportedLanguage, SymbolKind } from './types';

const MIN_CHUNK_TOKENS = 20;
const MAX_CHUNK_TOKENS = 1000;
const CLASS_SPLIT_THRESHOLD = 800; // Split class into methods if > this many tokens

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Lazy TypeScript loader ──

type TS = typeof import('typescript');
let _ts: TS | null = null;
let _tsLoadFailed = false;

async function getTS(): Promise<TS | null> {
  if (_ts) return _ts;
  if (_tsLoadFailed) return null;

  try {
    _ts = await loadTypeScriptCompiler();
    return _ts;
  } catch {
    _tsLoadFailed = true;
    console.warn('[skeleton] TypeScript compiler not available — chunking disabled');
    return null;
  }
}

// Synchronous version — only works after first async load
function getTSSync(): TS | null {
  return _ts;
}

/**
 * Pre-load the TypeScript module. Call this early to avoid the
 * cold-start penalty on the first chunkFile() call.
 */
export async function warmup(): Promise<boolean> {
  const ts = await getTS();
  return ts !== null;
}

// ── AST walking ──

function hasExportModifier(ts: TS, node: import('typescript').Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function getNodeName(ts: TS, node: import('typescript').Node, sourceFile: import('typescript').SourceFile): string | null {
  if ('name' in node) {
    const name = (node as { name?: import('typescript').Node }).name;
    if (name && 'getText' in name) {
      return (name as import('typescript').Identifier).getText(sourceFile);
    }
  }
  return null;
}

function extractImportsFromBody(body: string): string[] {
  const imports: string[] = [];
  // Match import-like references in the chunk body
  const matches = body.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g);
  for (const m of matches) {
    imports.push(m[1]);
  }
  return imports;
}

interface ExtractedChunk {
  symbolName: string;
  symbolKind: SymbolKind;
  body: string;
  startLine: number;
  endLine: number;
  startPos: number;
  endPos: number;
  exported: boolean;
  parent?: string;
}

/**
 * Extract chunks from a TypeScript/TSX source file using the compiler API.
 */
function extractChunksFromAST(
  ts: TS,
  content: string,
  fileName: string,
): ExtractedChunk[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  const chunks: ExtractedChunk[] = [];

  function posToLine(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  function extractNode(
    node: import('typescript').Node,
    kind: SymbolKind,
    name: string | null,
    parent?: string,
  ): void {
    if (!name) return;

    const startPos = node.getStart(sourceFile);
    const endPos = node.getEnd();
    const body = content.slice(startPos, endPos);

    chunks.push({
      symbolName: parent ? `${parent}.${name}` : name,
      symbolKind: kind,
      body,
      startLine: posToLine(startPos),
      endLine: posToLine(endPos),
      startPos,
      endPos,
      exported: hasExportModifier(ts, node),
      parent,
    });
  }

  function walkClassMembers(
    classNode: import('typescript').ClassDeclaration | import('typescript').ClassExpression,
    className: string,
  ): void {
    for (const member of classNode.members) {
      if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const methodName = getNodeName(ts, member, sourceFile);
        if (methodName) {
          extractNode(member, 'method', methodName, className);
        }
      } else if (ts.isConstructorDeclaration(member)) {
        extractNode(member, 'method', 'constructor', className);
      }
    }
  }

  // Walk top-level statements
  ts.forEachChild(sourceFile, (node) => {
    // Function declarations
    if (ts.isFunctionDeclaration(node)) {
      const name = getNodeName(ts, node, sourceFile);
      extractNode(node, 'function', name);
      return;
    }

    // Variable statements (const x = () => {}, const x = function() {})
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const name = getNodeName(ts, decl, sourceFile);
          // Extract the whole variable statement so the export/const prefix is included
          extractNode(node, 'function', name);
          break; // Only one declaration per statement typically has a function
        }
      }
      return;
    }

    // Class declarations
    if (ts.isClassDeclaration(node)) {
      const className = getNodeName(ts, node, sourceFile);
      if (!className) return;

      const startPos = node.getStart(sourceFile);
      const endPos = node.getEnd();
      const body = content.slice(startPos, endPos);
      const tokens = estimateTokens(body);

      if (tokens <= CLASS_SPLIT_THRESHOLD) {
        // Small class — one chunk
        extractNode(node, 'class', className);
      } else {
        // Large class — split into per-method chunks
        walkClassMembers(node, className);
      }
      return;
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node)) {
      const name = getNodeName(ts, node, sourceFile);
      extractNode(node, 'interface', name);
      return;
    }

    // Type alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
      const name = getNodeName(ts, node, sourceFile);
      extractNode(node, 'type', name);
      return;
    }

    // Enum declarations
    if (ts.isEnumDeclaration(node)) {
      const name = getNodeName(ts, node, sourceFile);
      extractNode(node, 'enum', name);
      return;
    }

    // Export default function/class (unnamed)
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr) || ts.isClassExpression(expr)) {
        extractNode(node, 'function', 'default');
      }
    }
  });

  return chunks;
}

// ── Public API ──

/**
 * Extract structural code chunks from a single TypeScript/TSX file.
 * Returns null if the TypeScript compiler isn't available.
 */
export function chunkFile(
  absolutePath: string,
  relativePath: string,
  language: SupportedLanguage,
): FileChunks | null {
  // Only TS/TSX files are supported for AST chunking
  if (language !== 'typescript' && language !== 'tsx') return null;

  const ts = getTSSync();
  if (!ts) return null;

  const content = readFileSync(absolutePath, 'utf-8');
  const contentHash = hashContent(content);

  const rawChunks = extractChunksFromAST(ts, content, relativePath);

  // Post-process: filter by size, add metadata
  const chunks: CodeChunk[] = [];

  for (const raw of rawChunks) {
    const tokenCount = estimateTokens(raw.body);

    // Skip trivial chunks
    if (tokenCount < MIN_CHUNK_TOKENS) continue;

    // If a chunk exceeds max tokens and isn't already a method,
    // we still keep it — the embedding pipeline can handle truncation.
    // We just flag it for potential future splitting.
    const localImports = extractImportsFromBody(raw.body);

    chunks.push({
      symbolName: raw.symbolName,
      symbolKind: raw.symbolKind,
      body: raw.body,
      startLine: raw.startLine,
      endLine: raw.endLine,
      startPos: raw.startPos,
      endPos: raw.endPos,
      tokenCount: Math.min(tokenCount, MAX_CHUNK_TOKENS * 2), // Cap estimate
      exported: raw.exported,
      parent: raw.parent,
      localImports,
    });
  }

  const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);

  return {
    relativePath,
    language,
    chunks,
    contentHash,
    totalTokens,
  };
}

/**
 * Chunk a file asynchronously (ensures TS module is loaded first).
 */
export async function chunkFileAsync(
  absolutePath: string,
  relativePath: string,
  language: SupportedLanguage,
): Promise<FileChunks | null> {
  await getTS();
  return chunkFile(absolutePath, relativePath, language);
}
