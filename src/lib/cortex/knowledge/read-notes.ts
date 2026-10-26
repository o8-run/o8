import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '@/lib/telemetry/scrub';
import { redactBroadcastText } from '@/lib/broadcast/redaction';
import type { KnowledgeSource } from '@/lib/operator/knowledge-source-defaults';
import { canonicalSource, containsPath } from './sources';

export interface Note { relativePath: string; title: string; wikiLinks: string[]; body: string }
export function secretChunk(text: string): boolean {
  return redactSecrets(text) !== text || redactBroadcastText(text) !== text
    || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|sk-(?:ant-|proj-|or-)?)[A-Za-z0-9_-]{16,}/.test(text);
}
function matches(pattern: string, relative: string): boolean {
  const parts = pattern.split('/');
  let expression = '^';
  parts.forEach((segment, index) => {
    if (segment === '**') expression += index === parts.length - 1 ? '.*' : '(?:[^/]+/)*';
    else {
      expression += [...segment].map(c => c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
      if (index < parts.length - 1) expression += '/';
    }
  });
  return new RegExp(expression + '$').test(relative);
}
function safeRead(root: string, file: string): string | null {
  let fd: number | undefined;
  try {
    const rootStat = lstatSync(root, { bigint: true });
    let current = root;
    for (const part of path.relative(root, file).split(path.sep)) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > BigInt(128 * 1024) || !containsPath(root, realpathSync(file))) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    const afterRoot = lstatSync(root, { bigint: true });
    if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev || opened.size > BigInt(128 * 1024)
      || rootStat.ino !== afterRoot.ino || rootStat.dev !== afterRoot.dev || realpathSync(root) !== root || !containsPath(root, realpathSync(file))) return null;
    const body = readFileSync(fd, 'utf8');
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || body.length > 128 * 1024) return null;
    return body;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
export function readNotes(source: KnowledgeSource): { notes: Note[]; directories: string[] } {
  canonicalSource(source);
  const directories: string[] = []; const notes: Note[] = []; const pending = [source.path];
  let entriesSeen = 0; let bytesRead = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    if (lstatSync(dir).isSymbolicLink() || !containsPath(source.path, realpathSync(dir))) continue;
    directories.push(dir);
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (++entriesSeen > 10_000) throw new Error('Knowledge folder exceeds the 10,000-entry limit. Narrow its patterns or choose a smaller folder.');
      if (item.name.startsWith('.')) continue;
      const file = path.join(dir, item.name); const rel = path.relative(source.path, file).split(path.sep).join('/');
      if (source.exclude.some(p => matches(p, rel) || rel.startsWith(p.replace(/\/\*\*$/, '') + '/'))) continue;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) { pending.push(file); continue; }
      if (!item.isFile() || !/\.md$/i.test(item.name) || !source.include.some(p => matches(p, rel))) continue;
      const body = safeRead(source.path, file); if (body === null) continue;
      bytesRead += Buffer.byteLength(body);
      if (bytesRead > 32 * 1024 * 1024) throw new Error('Knowledge folder exceeds the 32 MiB text limit. Narrow its patterns.');
      const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const title = front?.[1].match(/^title:\s*["']?([^\r\n"']+)/m)?.[1].trim() || body.match(/^#\s+(.+)$/m)?.[1].trim() || item.name.replace(/\.md$/i, '');
      const wikiLinks = [...new Set([...body.matchAll(/\[\[([^\]\r\n]{1,240})\]\]/g)].map(m => m[1]))].slice(0,100);
      notes.push({ relativePath: rel, title: title.slice(0,240), wikiLinks, body });
    }
  }
  return { notes, directories };
}
