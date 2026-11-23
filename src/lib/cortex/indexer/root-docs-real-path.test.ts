import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ callSonnet: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ callSonnet: transport.callSonnet }));

let root: string;
let repo: string;
let data: string;
let stop: (() => void) | undefined;
let database: typeof import('@/lib/db') | undefined;
const beforeFiles = new Map<string, string>();
const text = (subject: string) => `## ${subject}\n\n${subject} is the registered fixture repository's documented policy. `
  + 'Changes must preserve existing behavior and record the commands used to verify the result. '
  + 'The implementation and its regression tests belong in the same focused change.\n';

beforeEach(() => {
  vi.resetModules(); transport.callSonnet.mockReset();
  root = mkdtempSync(join(tmpdir(), 'o8-root-docs-')); repo = join(root, 'repo'); data = join(root, 'data');
  mkdirSync(data); mkdirSync(join(repo, 'notes'), { recursive: true }); mkdirSync(join(repo, 'docs'));
  beforeFiles.clear();
  for (const file of ['ROADMAP.md', 'CONTRIBUTING.md', 'NOTES.md', 'notes/ROADMAP.md', 'notes/CONTRIBUTING.md', 'notes/README.md', 'docs/guide.md']) {
    const body = text(file); beforeFiles.set(file, body); writeFileSync(join(repo, file), body);
  }
  writeFileSync(join(data, 'repos.json'), JSON.stringify({ repos: [{ name: 'fixture', localPath: repo }] }));
  vi.stubEnv('O8_DATA_DIR', data); vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(data, 'cortex-ide.db')); vi.stubEnv('O8_DISABLE_DOC_WATCH', '0');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  transport.callSonnet.mockImplementation(async (input: { messages: { content: string }[] }) => {
    const prompt = input.messages[0].content;
    const payload = prompt.split('\nChunks:\n')[1].split('\n\nOutput JSON object only:')[0];
    const chunks = JSON.parse(payload) as { id: string; text: string }[];
    return { text: JSON.stringify(Object.fromEntries(chunks.map(chunk => [chunk.id, [{ kind: 'process',
      content: chunk.text.split('. ')[0] + '.', source_excerpt: chunk.text.slice(0, 150), confidence: 0.9 }]]))) };
  });
});
afterEach(() => {
  stop?.(); stop = undefined; database?.closeDb(); database = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});
function batch(...args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/distill-docs.ts'), '--dry-run', ...args], {
    cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '--conditions=react-server' }, encoding: 'utf8', timeout: 20_000,
  });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function unchanged(except: string[] = []) {
  for (const [file, body] of beforeFiles) if (!except.includes(file)) expect(readFileSync(join(repo, file), 'utf8')).toBe(body);
}

it('discovers both exact root files through the real batch CLI without admitting unrelated or nested notes', () => {
  const output = batch();
  expect(output).toMatch(/files in scope\s+: 3\b/);
  expect(output).toMatch(/chunks to distill: 3\b/);
  expect(output).toContain('--dry-run: no LLM calls, no writes');
  unchanged();
});

it('preserves explicit excludes after adding the two root filenames to the batch defaults', () => {
  expect(batch('--exclude=ROADMAP.md')).toMatch(/files in scope\s+: 2\b/);
  expect(batch('--exclude=CONTRIBUTING.md')).toMatch(/files in scope\s+: 2\b/);
  unchanged();
});

it('watches both root files, persists cited facts for changed chunks only, and leaves nested notes out of scope', async () => {
  database = await import('@/lib/db'); database.getDb();
  const { startDocWatcher } = await import('./doc-watcher'); stop = startDocWatcher();
  // The startup walk is asynchronous: the watchers attach once it finishes.
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith('[doc-watcher] watching 3 file(s) for changes'), { timeout: 5_000, interval: 20 });
  expect(transport.callSonnet).not.toHaveBeenCalled();
  await new Promise(resolve => setTimeout(resolve, 100));
  const sqlite = database.getSqlite();
  const facts = () => database!.getSqlite().prepare('SELECT content, source_id, source_excerpt, repo_path, extracted_by FROM facts WHERE source_kind = ? ORDER BY source_id').all('doc') as {
    content: string; source_id: string; source_excerpt: string; repo_path: string; extracted_by: string;
  }[];
  for (const [index, file] of ['ROADMAP.md', 'CONTRIBUTING.md'].entries()) {
    const updated = text(`Updated ${file}`); writeFileSync(join(repo, file), updated);
    await vi.waitFor(() => expect(facts(), JSON.stringify(vi.mocked(console.log).mock.calls)).toHaveLength(index + 1), { timeout: 7_000, interval: 50 });
    const fact = facts().find(row => row.source_id === `doc:${repo}:${file}:0`)!;
    expect(fact).toMatchObject({ repo_path: repo, extracted_by: 'doc-watcher' });
    expect(fact.content).toContain(`Updated ${file}`); expect(updated).toContain(fact.source_excerpt);
    expect(readFileSync(join(repo, file), 'utf8')).toBe(updated);
    const checkpoint = sqlite.prepare('SELECT status FROM doc_distill_state WHERE source_id = ?').get(fact.source_id);
    expect(checkpoint).toEqual({ status: 'done' });
    expect(transport.callSonnet).toHaveBeenCalledTimes(index + 1);
  }
  // Re-saving identical text and editing excluded files must not spend another model turn.
  const roadmap = readFileSync(join(repo, 'ROADMAP.md'), 'utf8'); writeFileSync(join(repo, 'ROADMAP.md'), roadmap);
  writeFileSync(join(repo, 'notes/ROADMAP.md'), text('Excluded nested change'));
  await new Promise(resolve => setTimeout(resolve, 2_200));
  expect(transport.callSonnet).toHaveBeenCalledTimes(2);
  expect(facts().map(row => row.source_id)).toEqual([`doc:${repo}:CONTRIBUTING.md:0`, `doc:${repo}:ROADMAP.md:0`]);
  const chunks = transport.callSonnet.mock.calls.map(([input]) => {
    const prompt = (input as { messages: { content: string }[] }).messages[0].content;
    return JSON.parse(prompt.split('\nChunks:\n')[1].split('\n\nOutput JSON object only:')[0]) as { id: string; text: string }[];
  });
  expect(chunks.every(batch => batch.length === 1)).toBe(true);
  unchanged(['ROADMAP.md', 'CONTRIBUTING.md', 'notes/ROADMAP.md']);
  // Inspect persisted data after the watcher and connection close.
  stop(); stop = undefined; database.closeDb(); database.getDb();
  expect(facts()).toHaveLength(2);
});
