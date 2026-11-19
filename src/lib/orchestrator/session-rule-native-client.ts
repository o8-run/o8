import 'server-only';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { getWsBase } from '@/lib/panel/api-port';
import type { ComposerQueueTarget } from './composer-queue-types';
import type { WorkerCorrectionPayload, WorkerCorrectionReceipt } from './worker-correction-types';

/** Same operator gate as the window, no bridge credential, retry or Node write fallback. */
export async function commitNativeCorrectionHold(input: ComposerQueueTarget & {
  id: string; payload: WorkerCorrectionPayload; fences: Array<{ scope: string; version: number }>;
}): Promise<WorkerCorrectionReceipt> {
  const target = new URL('/api/orchestrator/session-rules?operation=correction-hold', getWsBase().replace(/^ws:/, 'http:'));
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Native correction hold requires the local operator transport.');
  let response: Response, body;
  try {
    const file = await open(join(getDataDir(), 'ws-token'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let token: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384) throw Error('Canonical operator authority unavailable.');
      const bytes = Buffer.alloc(16385); const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 16384) throw Error('Canonical operator authority unavailable.');
      token = bytes.subarray(0, read.bytesRead).toString('utf8').trim();
    } finally { await file.close(); }
    if (!token || Buffer.byteLength(token) > 16384) throw Error('Canonical operator authority unavailable.');
    response = await fetch(target, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(input), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    body = await response.json();
  } catch {
    throw new Error('Native correction hold outcome is unconfirmed. No delivery was attempted; inspect the correction before retrying.');
  }
  if (!response.ok) throw new Error(body?.error?.message || 'Native correction hold was refused. No delivery was attempted.');
  if (response.headers.get('x-o8d-native') !== '1' || body?.ok !== true || body.result?.id !== input.id || typeof body.result?.ruleId !== 'string') {
    throw new Error('Native correction hold receipt is unconfirmed. No delivery was attempted; inspect before retrying.');
  }
  return body.result;
}
