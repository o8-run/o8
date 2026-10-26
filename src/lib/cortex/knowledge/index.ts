import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { distillDocChunkBatch } from '@/lib/cortex/indexer/doc-distill';
import { chunkMarkdown } from '@/lib/cortex/indexer/markdown-chunks';
import { advanceMemoryRevision } from '@/lib/cortex/memory-revision';
import { invalidateAnswerCache } from '@/lib/cortex/qa/ask';
import type { KnowledgeSource } from '@/lib/operator/knowledge-source-defaults';
import { getOperatorDefaultsTomlPath } from '@/lib/settings/operator-defaults-store';
import { configuredKnowledgeSources } from './sources';
import { readNotes, secretChunk } from './read-notes';

const generations = new Map<string, number>();
const status = new Map<string, { state: 'indexing' | 'ready' | 'error'; error?: string }>();
let work: Promise<void> = Promise.resolve();
let lifecycle = 0;
let watcherStop: (() => void) | undefined;
export function ensureKnowledgeSourceWatcher() { if (process.env.O8_DISABLE_DOC_WATCH !== '1') watcherStop ??= startKnowledgeSourceWatcher(); }
export function stopKnowledgeSourceWatcher() { watcherStop?.(); watcherStop = undefined; }
function tables() {
  const db = getSqlite();
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
    source_id TEXT PRIMARY KEY, source TEXT NOT NULL, relative_path TEXT NOT NULL,
    title TEXT NOT NULL, wiki_links TEXT NOT NULL, text_hash TEXT NOT NULL)`);
  return db;
}
function changedMemory() { advanceMemoryRevision(getSqlite()); invalidateAnswerCache(); }
export function invalidateKnowledgeSource(id: string) { generations.set(id, (generations.get(id) ?? 0) + 1); }
export function forgetKnowledgeSource(id: string): void {
  invalidateKnowledgeSource(id);
  const db = tables();
  db.transaction(() => {
    db.prepare("DELETE FROM facts WHERE source_kind = 'knowledge' AND source_id IN (SELECT source_id FROM knowledge_chunks WHERE source = ?)").run(id);
    db.prepare('DELETE FROM knowledge_chunks WHERE source = ?').run(id);
    changedMemory();
  })();
  status.delete(id);
}
export function knowledgeSourceState(source: KnowledgeSource) {
  const db = tables();
  const row = db.prepare("SELECT count(*) AS count FROM facts WHERE source_kind = 'knowledge' AND source_id IN (SELECT source_id FROM knowledge_chunks WHERE source = ?)").get(source.id) as { count: number };
  return { ...source, ...(status.get(source.id) ?? { state: 'ready' as const }), facts: row.count };
}
export function knowledgeProvenance(sourceId: string) {
  const row = tables().prepare('SELECT source, relative_path, title, wiki_links FROM knowledge_chunks WHERE source_id = ?').get(sourceId) as { source: string; relative_path: string; title: string; wiki_links: string } | undefined;
  const source = row && configuredKnowledgeSources().find(s => s.id === row.source);
  if (!source || !row) return null;
  return { title: row.title, sourceName: source.name, sourcePath: path.join(source.path, row.relative_path), wikiLinks: JSON.parse(row.wiki_links) as string[] };
}
async function indexSource(source: KnowledgeSource): Promise<void> {
  const generation = generations.get(source.id) ?? 0;
  const current = () => (generations.get(source.id) ?? 0) === generation
    && configuredKnowledgeSources().some(s => JSON.stringify(s) === JSON.stringify(source));
  if (!current()) return;
  status.set(source.id, { state: 'indexing' });
  try {
    const { notes } = readNotes(source); const db = tables(); const retained = new Set<string>();
    for (const note of notes) {
      if (!current()) return;
      const chunks = chunkMarkdown(note.body);
      const safe = chunks.filter(chunk => !secretChunk(chunk.text) && !chunk.headingPath.some(secretChunk) && !secretChunk(note.relativePath) && !secretChunk(source.name));
      const ids = safe.map(c => `knowledge:${source.id}:${encodeURIComponent(note.relativePath)}:${c.chunkIdx}`);
      ids.forEach(id => retained.add(id));
      const title = secretChunk(note.title) ? 'Notes' : note.title;
      const links = JSON.stringify(note.wikiLinks.filter(link => !secretChunk(link)));
      const metadataChanged = (db.prepare('SELECT title, wiki_links FROM knowledge_chunks WHERE source = ? AND relative_path = ? LIMIT 1').get(source.id, note.relativePath) as { title: string; wiki_links: string } | undefined);
      const old = db.prepare('SELECT source_id FROM knowledge_chunks WHERE source = ? AND relative_path = ?').all(source.id, note.relativePath) as Array<{ source_id: string }>;
      // Deletions and newly sensitive chunks stop being retrievable before any inference.
      db.transaction(() => { for (const row of old) if (!ids.includes(row.source_id)) {
        db.prepare("DELETE FROM facts WHERE source_kind = 'knowledge' AND source_id = ?").run(row.source_id);
        db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(row.source_id);
        changedMemory();
      } })();
      const pending = safe.map((chunk, i) => ({ ...chunk, id: ids[i], hash: createHash('sha256').update(JSON.stringify([source.name, note.relativePath, chunk.headingPath, chunk.text])).digest('hex') }));
      const changed = pending.filter(chunk => (db.prepare('SELECT text_hash FROM knowledge_chunks WHERE source_id = ?').get(chunk.id) as { text_hash: string } | undefined)?.text_hash !== chunk.hash);
      const result = changed.length ? await distillDocChunkBatch({ chunks: changed.map(c => ({ id: c.id, repoName: source.name,
        relPath: note.relativePath, headingPath: c.headingPath, text: c.text })), timeoutMs: 240_000 }) : { factsByChunkId: new Map() };
      if (!current()) return;
      db.transaction(() => {
        for (const chunk of pending) {
          if (changed.some(c => c.id === chunk.id)) {
            db.prepare("DELETE FROM facts WHERE source_kind = 'knowledge' AND source_id = ?").run(chunk.id);
            for (const fact of result.factsByChunkId.get(chunk.id) ?? []) {
              if (fact.confidence < 0.6 || !Number.isFinite(fact.confidence) || !fact.source_excerpt || !chunk.text.includes(fact.source_excerpt)
                || secretChunk(fact.content) || secretChunk(fact.source_excerpt)) continue;
              db.prepare(`INSERT INTO facts (id, kind, content, source_kind, source_id, source_excerpt, repo_path, confidence, fingerprint, extracted_by, source_authority)
                VALUES (?, ?, ?, 'knowledge', ?, ?, NULL, ?, ?, 'doc-distiller', 0.85) ON CONFLICT(fingerprint) DO NOTHING`).run(randomUUID(), fact.kind, fact.content, chunk.id, fact.source_excerpt,
                fact.confidence, createHash('sha256').update(chunk.id + '\n' + fact.content).digest('hex'));
            }
          }
          db.prepare(`INSERT INTO knowledge_chunks (source_id, source, relative_path, title, wiki_links, text_hash) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET title=excluded.title, wiki_links=excluded.wiki_links, text_hash=excluded.text_hash`)
            .run(chunk.id, source.id, note.relativePath, title, links, chunk.hash);
        }
        if (changed.length || metadataChanged?.title !== title || metadataChanged?.wiki_links !== links) changedMemory();
      })();
    }
    if (!current()) return;
    db.transaction(() => {
      for (const row of db.prepare('SELECT source_id FROM knowledge_chunks WHERE source = ?').all(source.id) as Array<{ source_id: string }>) {
        if (retained.has(row.source_id)) continue;
        db.prepare("DELETE FROM facts WHERE source_kind = 'knowledge' AND source_id = ?").run(row.source_id);
        db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(row.source_id); changedMemory();
      }
    })();
    status.set(source.id, { state: 'ready' });
  } catch { if (current()) status.set(source.id, { state: 'error', error: 'This folder could not be indexed. Check its path, patterns and connected Brain runtime, then retry.' }); }
}
export function indexKnowledgeSources(): Promise<void> {
  configuredKnowledgeSources().forEach(s => status.set(s.id, { state: 'indexing' }));
  const epoch = lifecycle;
  work = work.catch(() => {}).then(async () => {
    if (epoch !== lifecycle) return;
    const sources = configuredKnowledgeSources();
    const db = tables();
    for (const row of db.prepare('SELECT DISTINCT source FROM knowledge_chunks').all() as Array<{ source: string }>) {
      if (!sources.some(s => s.id === row.source)) forgetKnowledgeSource(row.source);
    }
    for (const source of sources) await indexSource(source);
  });
  return work;
}
/** Same server lifecycle as the repository doc watcher; all handles read source folders only. */
export function startKnowledgeSourceWatcher(): () => void {
  let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
  let handles: ReturnType<typeof watch>[] = [];
  const queue = () => { if (stopped) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { void synchronize(); }, 2_000); };
  const synchronize = async () => {
    if (stopped) return;
    handles.forEach(h => h.close()); handles = [];
    const sources = configuredKnowledgeSources();
    for (const source of sources) {
      try { for (const dir of readNotes(source).directories) { const h = watch(dir, queue); h.on('error', queue); h.unref(); handles.push(h); } } catch { /* Index status reports unreadable sources. */ }
    }
    const settings = getOperatorDefaultsTomlPath();
    try { const h = watch(path.dirname(settings), (_event, name) => { if (name?.toString() === path.basename(settings)) queue(); }); h.on('error', queue); h.unref(); handles.push(h); } catch { /* The add route also starts an index job. */ }
    await indexKnowledgeSources();
  };
  const rescan = setInterval(queue, 60_000); rescan.unref();
  void synchronize();
  return () => { clearInterval(rescan); stop(); };
  function stop() { stopped = true; lifecycle += 1; if (timer) clearTimeout(timer); handles.forEach(h => h.close()); configuredKnowledgeSources().forEach(s => invalidateKnowledgeSource(s.id)); }
}
