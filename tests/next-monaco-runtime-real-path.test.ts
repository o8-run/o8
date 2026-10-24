// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { getMonacoLanguage } from '@/components/desktop/file-viewer-monaco';
import { loadBundledMonacoEditor } from '@/components/desktop/file-viewer/bundled-monaco';

it('registers only languages opened by the file viewer and retains its five worker routes', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const workers: string[] = [];
  vi.stubGlobal('Worker', class {
    constructor(url: URL) { workers.push(url.pathname); }
  });
  await loadBundledMonacoEditor();
  const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js');
  const registered = monaco.languages.getLanguages().map(language => language.id).sort();
  const opened = new Set(['plaintext', ...[
    'main.ts', 'main.js', 'data.json', 'config.yaml', 'README.md', 'index.html', 'data.xml',
    'style.css', 'style.scss', 'style.less', 'main.py', 'main.rs', 'main.go', 'main.rb',
    'Main.java', 'main.c', 'main.cpp', 'script.sh', 'query.sql', 'query.graphql',
    'main.swift', 'main.kt', 'main.r', 'main.lua', 'main.php', 'main.perl', '.env', 'Dockerfile',
  ].map(getMonacoLanguage)]);
  expect(registered.filter(id => !opened.has(id))).toEqual([]);
  for (const id of opened) expect(registered).toContain(id);
  const host = self as typeof self & { MonacoEnvironment: { getWorker(id: string, label: string): Worker } };
  for (const label of ['json', 'css', 'scss', 'less', 'html', 'typescript', 'javascript', 'editorWorkerService']) {
    host.MonacoEnvironment.getWorker('', label);
  }
  expect(workers.map(value => value.split('/').pop())).toEqual([
    'json.worker.js', 'css.worker.js', 'css.worker.js', 'css.worker.js',
    'html.worker.js', 'ts.worker.js', 'ts.worker.js', 'editor.worker.js',
  ]);
  vi.unstubAllGlobals();
});
