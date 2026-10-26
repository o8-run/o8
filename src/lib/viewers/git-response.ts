import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { readWorkspaceFile } from '@/lib/fs/workspace-file';
import { credentialSourceRanges, isViewerDiff, type OutputRedactionContext } from '@/lib/acp/output-redaction';
import { viewerRedactionPolicy } from './policy';
import { viewerJson } from './response';

const run = promisify(execFile);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
interface Refs { oldRef?: string; newRef?: string }
function pathName(value: string | undefined): string | null | undefined {
  if (!value) return undefined;
  if (value === '/dev/null') return null;
  try { if (value.startsWith('"')) value = JSON.parse(value) as string; } catch { return undefined; }
  return typeof value === 'string' ? value.slice(2) : undefined;
}
function sourceLines(text: string, policy: OutputRedactionContext) {
  const ranges = credentialSourceRanges(text, policy);
  let offset = 0; let cursor = 0;
  return text.split('\n').map(line => {
    while (cursor < ranges.length && ranges[cursor].end <= offset) cursor++;
    const secret = cursor < ranges.length && ranges[cursor].start < offset + line.length && ranges[cursor].end > offset;
    offset += line.length + 1;
    return { text: line, secret };
  });
}
/** Match every emitted source line against complete, identity-checked file contents. */
async function sanitizeSection(section: string, root: string, fallback: string | undefined, refs: Refs, policy: OutputRedactionContext, cache: Map<string, Promise<string | null>>): Promise<string> {
  if (!isViewerDiff(section)) return section;
  if (!root) return '[redacted]\n';
  const oldPath = pathName(section.match(/^--- (.+)$/m)?.[1]) ?? fallback;
  const newPath = pathName(section.match(/^\+\+\+ (.+)$/m)?.[1]) ?? fallback;
  const ids = section.match(/^index ([a-f0-9]+)\.\.([a-f0-9]+)/m);
  const blob = (object: string) => {
    const key = `blob:${object}`;
    if (!cache.has(key)) cache.set(key, run('git', ['cat-file', 'blob', object], { cwd: root, encoding: 'utf8', maxBuffer: MAX_SOURCE_BYTES, timeout: 5000, windowsHide: true }).then(result => result.stdout.includes('\0') ? null : result.stdout).catch(() => null));
    return cache.get(key)!;
  };
  const source = async (side: 'old' | 'new'): Promise<string | null> => {
    const rawPath = side === 'old' ? section.match(/^--- (.+)$/m)?.[1] : section.match(/^\+\+\+ (.+)$/m)?.[1];
    const id = side === 'old' ? ids?.[1] : ids?.[2];
    if (rawPath === '/dev/null' || id && /^0+$/.test(id)) return '';
    const path = side === 'old' ? oldPath : newPath;
    if (!path || path.startsWith('/') || path.split('/').includes('..')) return null;
    if (id) { const stored = await blob(id); if (stored !== null) return stored; }
    const ref = side === 'old' ? refs.oldRef : refs.newRef;
    if (ref) { const stored = await blob(`${ref}:${path}`); if (stored !== null) return stored; }
    if (side === 'old') return null;
    const key = `workspace:${path}:${id ?? ''}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      try {
        const file = await readWorkspaceFile(root, path);
        if (file.bytes.length > MAX_SOURCE_BYTES || file.bytes.includes(0) || !id) return null;
        const prefix = Buffer.from(`blob ${file.bytes.length}\0`);
        const matches = ['sha1', 'sha256'].some(algorithm => createHash(algorithm).update(prefix).update(file.bytes).digest('hex').startsWith(id));
        return matches ? file.bytes.toString('utf8') : null;
      } catch { return null; }
    })());
    return cache.get(key)!;
  };
  const [old, next] = await Promise.all([source('old'), source('new')]);
  if (old === null || next === null) return '[redacted]\n';
  const before = sourceLines(old, policy); const after = sourceLines(next, policy);
  let oldLine = 0; let newLine = 0; let oldRemaining = 0; let newRemaining = 0; let inHunk = false;
  const result: string[] = [];
  for (const line of section.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      if (oldRemaining || newRemaining) return '[redacted]\n';
      oldLine = Number(hunk[1]) - 1; newLine = Number(hunk[3]) - 1;
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1); inHunk = true;
      // Function-heading suffixes are unprojected source excerpts.
      result.push(hunk[0]); continue;
    }
    if (!inHunk || line.startsWith('\\ No newline') || !line) { result.push(line); continue; }
    const prefix = line[0]; const value = line.slice(1);
    const usesOld = prefix === '-' || prefix === ' '; const usesNew = prefix === '+' || prefix === ' ';
    if (!usesOld && !usesNew) return '[redacted]\n';
    if (usesOld && (oldRemaining <= 0 || before[oldLine]?.text !== value)) return '[redacted]\n';
    if (usesNew && (newRemaining <= 0 || after[newLine]?.text !== value)) return '[redacted]\n';
    const secret = usesOld && before[oldLine].secret || usesNew && after[newLine].secret;
    result.push(secret ? `${prefix}[redacted]` : line);
    if (usesOld) { oldLine++; oldRemaining--; } if (usesNew) { newLine++; newRemaining--; }
  }
  // A byte cap or a hunk gap can never expose an unverified fragment.
  if (oldRemaining || newRemaining) return '[redacted]\n';
  return result.join('\n');
}
export async function viewerGitJson<T extends object>(value: T, root: string, refs: Refs = {}, init?: ResponseInit) {
  const policy = viewerRedactionPolicy(); const verifiedDiffs = new Set<string>();
  const cache = new Map<string, Promise<string | null>>();
  const visit = async (item: unknown, path?: string): Promise<unknown> => {
    if (typeof item === 'string' && isViewerDiff(item)) {
      const sections = item.split(/(?=^diff --git )/m);
      const safe = (await Promise.all(sections.map(section => sanitizeSection(section, root, path, refs, policy, cache)))).join('');
      verifiedDiffs.add(safe); return safe;
    }
    if (Array.isArray(item)) return Promise.all(item.map(child => visit(child, path)));
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const file = typeof record.path === 'string' ? record.path : typeof record.filePath === 'string' ? record.filePath : path;
      return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, child]) => [key, await visit(child, file)])));
    }
    return item;
  };
  return viewerJson(await visit(value) as T, init, { ...policy, verifiedDiffs });
}
