import { afterAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'o8-mcp-bootstrap-payer-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('re-execs on Node 22 without loading native SQLite or forwarding provider credentials', () => {
  const fakeNode = join(root, 'node22');
  const receipt = join(root, 'child.json');
  const helper = join(root, 'bootstrap.cjs');
  writeFileSync(fakeNode, `#!${process.execPath}
const fs=require('node:fs');
if (!process.argv.includes('--version')) fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({
 provider:!!process.env.ANTHROPIC_API_KEY, ambient:!!process.env.O8_UNAPPROVED_AMBIENT,
 guard:process.env.O8_MCP_REEXECED === '1', profile:process.env.O8_OPERATOR_MCP_PROFILE, readonly:process.env.CORTEX_READONLY
}));
console.log('v22.3.0');
`, { mode: 0o700 });
  writeFileSync(helper, `
const Module=require('node:module'); const load=Module._load;
Module._load=function(id,...rest){if(id==='better-sqlite3')throw new Error('fixture native addon unavailable');return load.call(this,id,...rest)};
Object.defineProperty(process.versions,'node',{value:'20.0.0'});
require(${JSON.stringify(join(process.cwd(), 'src/lib/mcp/operator-node22-reexec.ts'))});
`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', helper], {
    cwd: process.cwd(), env: { NODE_ENV:'test', PATH: process.env.PATH, HOME: root, CORTEX_IDE_DATA_DIR: root,
      O8_NODE_BIN: fakeNode, O8_OPERATOR_MCP_PROFILE:'devices', CORTEX_READONLY:'1', ANTHROPIC_API_KEY: 'fixture-bootstrap-provider', O8_UNAPPROVED_AMBIENT: 'fixture-other' },
  });
  expect(result.status === 0).toBe(true);
  expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ provider: false, ambient: false, guard: true, profile:'devices', readonly:'1' });
});
