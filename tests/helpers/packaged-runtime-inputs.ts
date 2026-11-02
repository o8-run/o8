import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Minimal resolvable JavaScript loader chain, without host-specific native code. */
export const RUNTIME_INPUT_FILES: Record<string, string> = {
  '.next/server/app/page.js': 'module.exports = {};',
  'node_modules/better-sqlite3/package.json': '{"main":"lib/index.js"}',
  'node_modules/better-sqlite3/lib/index.js': "module.exports = require('./database');",
  'node_modules/better-sqlite3/lib/database.js': "module.exports = require('bindings');",
  'node_modules/bindings/package.json': '{"main":"bindings.js"}',
  'node_modules/bindings/bindings.js': "module.exports = require('file-uri-to-path');",
  'node_modules/file-uri-to-path/package.json': '{"main":"index.js"}',
  'node_modules/file-uri-to-path/index.js': 'module.exports = () => {};',
};

export function stageRuntimeInputs(server: string) {
  for (const [file, contents] of Object.entries(RUNTIME_INPUT_FILES)) {
    mkdirSync(dirname(join(server, file)), { recursive: true });
    writeFileSync(join(server, file), contents);
  }
}
