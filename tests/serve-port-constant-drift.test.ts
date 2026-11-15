import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROD_API_PORT_BLOCK, PROD_WS_PORT_BLOCK } from '@/lib/panel/port-constants';

const root = resolve(import.meta.dirname, '..');
const PANEL_PATH = 'src/lib/panel/port-constants.ts';
const CLI_PATH = 'cli/src/commands/serve.ts';
// The shell and the launcher share these constants through the launch core crate.
const RUST_PATH = 'crates/o8-launch-core/src/ports.rs';
const SOURCE_PATHS = [PANEL_PATH, CLI_PATH, RUST_PATH] as const;

interface PortBlocks {
  api: number[];
  ws: number[];
}

function parseTypeScriptBlock(source: string, name: string): number[] {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]+)\\] as const;`));
  if (!match) throw new Error(`Could not parse ${name} from ${CLI_PATH}.`);
  return match[1].split(',').map((value) => Number.parseInt(value.trim(), 10));
}

function parseRustRange(source: string, name: string): number[] {
  const match = source.match(new RegExp(`const ${name}: std::ops::Range<u16> = (\\d+)\\.\\.(\\d+);`));
  if (!match) throw new Error(`Could not parse ${name} from ${RUST_PATH}.`);
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  return Array.from({ length: end - start }, (_, index) => start + index);
}

describe('headless serve production port constants', () => {
  it('prevents shell declarations from shadowing shared production port constants', () => {
    const shell = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');
    expect(shell).not.toMatch(/\b(?:const|static)\s+PROD_(?:API|WS)_[A-Z_]*PORT[A-Z_]*\s*:/);
  });
  it('keeps the panel, CLI bundle copy, and native shell blocks equal', () => {
    const cliSource = readFileSync(join(root, CLI_PATH), 'utf8');
    const rustSource = readFileSync(join(root, RUST_PATH), 'utf8');
    const blocks: Record<(typeof SOURCE_PATHS)[number], PortBlocks> = {
      [PANEL_PATH]: {
        api: [...PROD_API_PORT_BLOCK],
        ws: [...PROD_WS_PORT_BLOCK],
      },
      [CLI_PATH]: {
        api: parseTypeScriptBlock(cliSource, 'PROD_API_PORT_BLOCK'),
        ws: parseTypeScriptBlock(cliSource, 'PROD_WS_PORT_BLOCK'),
      },
      [RUST_PATH]: {
        api: parseRustRange(rustSource, 'PROD_API_PORT_RANGE'),
        ws: parseRustRange(rustSource, 'PROD_WS_PORT_RANGE'),
      },
    };
    const expected = JSON.stringify(blocks[PANEL_PATH]);
    const equal = SOURCE_PATHS.every((path) => JSON.stringify(blocks[path]) === expected);
    const evidence = SOURCE_PATHS.map((path) => `${path}: ${JSON.stringify(blocks[path])}`).join('\n');

    expect(equal, `Production port blocks drifted across ${SOURCE_PATHS.join(', ')}.\n${evidence}`).toBe(true);
  });
});
