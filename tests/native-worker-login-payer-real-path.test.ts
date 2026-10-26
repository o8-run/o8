import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it, vi } from 'vitest';
const root=mkdtempSync(join(tmpdir(),'o8-native-login-payer-'));
const saved='fixture-native-login-provider-material';
const login=`sk-ant-oat01-${'fixture'.repeat(14)}`;
vi.stubEnv('O8_DATA_DIR',root); vi.stubEnv('CORTEX_IDE_DATA_DIR',root);
vi.stubEnv('O8_MASTER_KEY',Buffer.alloc(32,109).toString('base64url'));
const {mutateProviderKey}=await import('@/lib/providers/key-store');
mutateProviderKey('OPENAI_API_KEY',{key:saved});
const {saveRuntimeBillingMode}=await import('@/lib/providers/runtime-billing');
const binary=join(root,'claude'),record=join(root,'observed.json');
writeFileSync(binary,`#!${process.execPath}
if(process.argv.includes('--version')) {console.log('2.1.261');process.exit(0);}
require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({savedPresent:Object.values(process.env).some(value=>value?.includes(${JSON.stringify(saved)})),unlisted:!!process.env.UNLISTED_LOGIN_SECRET,master:!!process.env.O8_MASTER_KEY}));
setTimeout(()=>console.log(${JSON.stringify(login)}),100);
`,{mode:0o755});
afterAll(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
it.each(['subscription','api'] as const)('native login PTY excludes saved credentials and unlisted inputs under %s settings',async mode=>{
  saveRuntimeBillingMode('claude-code',mode);
  const env: NodeJS.ProcessEnv={...process.env,O8_CLAUDE_CODE_BIN:binary,OPENAI_API_KEY:saved,NPM_TOKEN:saved,LOGIN_ALIAS:saved,UNLISTED_LOGIN_SECRET:'fixture-private-input',O8_WORKER_ENV_INHERIT:'1',O8_WORKER_ENV_ALLOW:'NPM_TOKEN,UNLISTED_LOGIN_SECRET'};
  delete env.O8_WORKER_TOKEN; delete env.O8_WORKER_PACKET_ID; delete env.O8_SPECTATOR_TOKEN;
  const result=await promisify(execFile)(process.execPath,['--import','./scripts/register-server-only-stub.mjs','--import','tsx','--import','./tests/fixtures/native-login-host.cjs','scripts/connect-native-worker.ts'],{cwd:process.cwd(),env,timeout:15000,maxBuffer:16384});
  expect(JSON.parse(readFileSync(record,'utf8'))).toEqual({savedPresent:false,unlisted:false,master:false});
  expect((result.stdout+result.stderr).includes(saved)).toBe(false);
  expect((result.stdout+result.stderr).includes(login)).toBe(false);
},20000);
