export async function loadBundledMonacoEditor() {
  if (typeof window !== 'undefined') {
    await import('@/lib/monaco-polyfills');
    const [monaco, react] = await Promise.all([import('./monaco-languages'), import('@monaco-editor/react')]);
    const host = self as typeof self & { MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker } };
    host.MonacoEnvironment = {
      getWorker(_id, label) {
        if (label === 'json') return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' });
        if (label === 'css' || label === 'scss' || label === 'less') return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), { type: 'module' });
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), { type: 'module' });
        if (label === 'typescript' || label === 'javascript') return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' });
        return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' });
      },
    };
    react.loader.config({ monaco });
    return react.default;
  }
  throw new Error('The editor loads in the browser.');
}
