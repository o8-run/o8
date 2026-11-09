import { execFile } from '@/lib/providers/child-process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { TypedRow } from '@/lib/cortex/qa/types';

export interface StrongGrepOptions {
  fileBudget?: number;
  maxBytesPerFile?: number;
  totalContentBudget?: number;
}

interface StrongGrepDeps {
  tokenize: (question: string) => string[];
  fallback: (
    question: string,
    repoPath: string | undefined,
    topK?: number,
  ) => Promise<TypedRow[]>;
  /** Reads a hit; the server passes one that refuses links and paths outside repoPath. */
  readFile?: (repoPath: string, relPath: string) => Promise<string>;
}

const DEFAULT_FILE_BUDGET = 8;
const DEFAULT_BYTES_PER_FILE = 8 * 1024;
const DEFAULT_TOTAL_CONTENT_BUDGET = 16 * 1024;
const RG_EXCLUDES = [
  '!node_modules/**',
  '!.git/**',
  '!dist/**',
  '!out/**',
  '!.next/**',
  '!build/**',
  '!coverage/**',
  '!**/*.lock',
  '!**/package-lock.json',
  '!tests/qa-eval/three-way-results-*.json',
];

function rgArgs(keyword: string): string[] {
  const args = ['--hidden', '--no-messages', '--with-filename', '-F', '-i', '-c'];
  for (const glob of RG_EXCLUDES) {
    args.push('--glob', glob);
  }
  args.push('--', keyword, '.');
  return args;
}

function runRgCount(keyword: string, repoPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'rg',
      rgArgs(keyword),
      { windowsHide: true, cwd: repoPath, maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const code = (err as { code?: unknown }).code;
        if (code === 1 || code === '1') {
          resolve(stdout);
          return;
        }
        reject(err);
      },
    );
  });
}

function parseCountLine(line: string): { relPath: string; count: number } | null {
  const idx = line.lastIndexOf(':');
  if (idx <= 0) return null;
  const count = Number(line.slice(idx + 1));
  if (!Number.isFinite(count) || count <= 0) return null;
  const relPath = line.slice(0, idx).replace(/^\.\//, '');
  if (!relPath || path.isAbsolute(relPath)) return null;
  return { relPath, count };
}

function matchedWindows(lines: string[], keywords: string[]): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lower = (lines[i] ?? '').toLowerCase();
    if (!keywords.some((kw) => lower.includes(kw))) continue;
    const next = { start: Math.max(0, i - 3), end: Math.min(lines.length - 1, i + 3) };
    const prev = windows[windows.length - 1];
    if (prev && next.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, next.end);
    } else {
      windows.push(next);
    }
  }
  return windows;
}

function renderWindows(
  lines: string[],
  windows: Array<{ start: number; end: number }>,
  maxBytes: number,
): { excerpt: string; line: number } | null {
  const first = windows[0];
  if (!first || maxBytes <= 0) return null;
  const chunks: string[] = [];
  let used = 0;
  for (const win of windows) {
    const prefix = chunks.length === 0 ? '' : '\n---\n';
    const block = lines
      .slice(win.start, win.end + 1)
      .map((line, idx) => `L${win.start + idx + 1}: ${line}`)
      .join('\n');
    const chunk = `${prefix}${block}`;
    const len = Buffer.byteLength(chunk, 'utf-8');
    if (used + len > maxBytes) {
      const remaining = Math.max(0, maxBytes - used);
      if (remaining > 24) chunks.push(chunk.slice(0, remaining - 16) + '\n...[truncated]');
      break;
    }
    chunks.push(chunk);
    used += len;
  }
  return { excerpt: chunks.join(''), line: first.start + 1 };
}

async function fallbackRows(
  deps: StrongGrepDeps,
  question: string,
  repoPath: string | undefined,
): Promise<TypedRow[]> {
  try {
    return await deps.fallback(question, repoPath, 15);
  } catch {
    return [];
  }
}

export async function buildStrongGrepTopRowsImpl(
  question: string,
  repoPath: string | undefined,
  opts: StrongGrepOptions & StrongGrepDeps,
): Promise<TypedRow[]> {
  if (!repoPath) return fallbackRows(opts, question, repoPath);
  try {
    const keywords = opts.tokenize(question);
    if (keywords.length === 0) return [];
    const hitCounts = new Map<string, number>();
    for (const keyword of keywords) {
      const stdout = await runRgCount(keyword, repoPath);
      for (const line of stdout.split('\n')) {
        const parsed = parseCountLine(line);
        if (!parsed) continue;
        hitCounts.set(parsed.relPath, (hitCounts.get(parsed.relPath) ?? 0) + parsed.count);
      }
    }
    const ranked = [...hitCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.fileBudget ?? DEFAULT_FILE_BUDGET);

    const rows: TypedRow[] = [];
    let remaining = opts.totalContentBudget ?? DEFAULT_TOTAL_CONTENT_BUDGET;
    const perFileBudget = opts.maxBytesPerFile ?? DEFAULT_BYTES_PER_FILE;
    for (const [relPath, hitCount] of ranked) {
      if (remaining <= 0) break;
      let content: string;
      try {
        content = opts.readFile
          ? await opts.readFile(repoPath, relPath)
          : await fs.readFile(path.join(repoPath, relPath), 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      const rendered = renderWindows(
        lines,
        matchedWindows(lines, keywords),
        Math.min(perFileBudget, remaining),
      );
      if (!rendered?.excerpt) continue;
      remaining -= Buffer.byteLength(rendered.excerpt, 'utf-8');
      rows.push({
        citation: {
          kind: 'doc',
          rowId: `strong-grep:${relPath}:L${rendered.line}`,
          table: 'doc',
          sourcePath: relPath,
          line: rendered.line,
          excerpt: rendered.excerpt,
        },
        fields: {
          strong_grep_source: relPath,
          strong_grep_line: rendered.line,
          strong_grep_score: hitCount,
          content: rendered.excerpt,
        },
        score: hitCount,
      });
    }
    return rows;
  } catch {
    return fallbackRows(opts, question, repoPath);
  }
}
