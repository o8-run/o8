import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OsPlanStore } from '@/lib/chatgpt-plan/credential-store';
import { ChatGPTPlanService } from '@/lib/chatgpt-plan/service';
import { emptyPlanRecord, PLAN_SCOPES, type PlanRecord, type PlanStore } from '@/lib/chatgpt-plan/types';

/** Synthetic credentials only. This is not an alternate production store. */
export class FixturePlanStore implements PlanStore {
  private readonly locks: OsPlanStore;
  constructor(private readonly directory: string) { this.locks = new OsPlanStore(directory); }
  hostId() { return this.locks.hostId(); }
  locked<T>(owner: string, action: () => Promise<T>) { return this.locks.locked(owner, action); }
  private path(owner: string) { return join(this.directory, `${createHash('sha256').update(owner).digest('hex')}.fixture.json`); }
  async read(owner: string): Promise<PlanRecord> {
    try { return JSON.parse(await readFile(this.path(owner), 'utf8')) as PlanRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPlanRecord(owner); throw error; }
  }
  async write(owner: string, record: PlanRecord) { await writeFile(this.path(owner), JSON.stringify(record), { mode: 0o600 }); }
}

export async function createPlanFixture(store: PlanStore) {
  const pair = await generateKeyPair('RS256');
  const key = { ...await exportJWK(pair.publicKey), kid: 'plan-fixture', alg: 'RS256', use: 'sig' };
  const calls: Array<{ path: string; body: Record<string, string>; authorization?: string }> = [];
  let base = ''; let nonce = ''; let expectedVerifierChallenge = ''; let expectedRedirect = '';
  const control = { scopes: PLAN_SCOPES, subject: 'fixture-openai-subject', audience: 'fixture-issued-client', nonceOverride: '', responseMode: 'complete', refreshFailure: '', refreshStatus: 400, refreshCount: 0, expectedRefresh: 'fixture-refresh-0', revokeFailure: false, toolName: 'list_files' };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const body = Object.fromEntries(new URLSearchParams(text));
      const path = request.url ?? '';
      calls.push({ path, body, authorization: request.headers.authorization });
      const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (path === '/jwks') return json({ keys: [key] });
      if (path === '/token') {
        if (body.grant_type === 'authorization_code') {
          if (body.redirect_uri !== expectedRedirect || createHash('sha256').update(body.code_verifier).digest('base64url') !== expectedVerifierChallenge) return json({ error: 'invalid_grant' }, 400);
        } else {
          control.refreshCount += 1;
          if (control.refreshFailure) return json({ error: control.refreshFailure }, control.refreshStatus);
          if (body.refresh_token !== control.expectedRefresh) return json({ error: 'refresh_token_reused' }, 400);
          await new Promise<void>((resolve) => setTimeout(resolve, 75));
        }
        const count = control.refreshCount;
        control.expectedRefresh = `fixture-refresh-${count}`;
        const idToken = await new SignJWT({ nonce: control.nonceOverride || nonce, email: 'fixture@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: key.kid }).setIssuer(base).setSubject(control.subject).setAudience(control.audience).setIssuedAt().setExpirationTime('10m').sign(pair.privateKey);
        return json({ token_type: 'Bearer', access_token: `fixture-access-${count}`, refresh_token: control.expectedRefresh, id_token: idToken, scope: control.scopes, expires_in: 3600 });
      }
      if (path === '/revoke') return json({}, control.revokeFailure ? 503 : 200);
      if (path === '/v1/models') {
        if (!request.headers.authorization?.startsWith('Bearer fixture-access-')) return json({ error: { code: 'subscription_sharing_invalid_user' } }, 401);
        return json({ models: [{ slug: 'fixture-plan-model', display_name: 'Fixture model', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hide' }] });
      }
      if (path === '/v1/responses') {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        calls[calls.length - 1].body = parsed as Record<string, string>;
        if (control.responseMode === 'admission') return json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429);
        const frames = [{ type: 'response.output_text.delta', delta: 'Fixture plan answer' }];
        if (control.responseMode === 'tool' || control.responseMode === 'approval') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', namespace: 'o8', name: control.toolName, call_id: 'fixture-tool-call', arguments: JSON.stringify(control.responseMode === 'approval' ? { path: 'fixture.txt', content: 'bounded test edit' } : { path: '.' }) } })}\n\n`);
          response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 3 } } })}\n\n`);
          control.responseMode = 'complete'; response.end(); return;
        }
        const ending = control.responseMode === 'failed'
          ? { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }
          : { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 3 } } };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (control.responseMode !== 'incomplete') response.write(`data: ${JSON.stringify(ending)}\n\n`);
        response.end(); return;
      }
      json({}, 404);
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  base = `http://127.0.0.1:${address.port}`;
  const config = { issuer: base, authorization: `${base}/authorize`, token: `${base}/token`, jwks: `${base}/jwks`, revocation: `${base}/revoke`, resource: `${base}/v1` };
  const service = new ChatGPTPlanService(store, config);
  return { service, config, calls, control, async authorize(start: { attemptId: string; authorizationUrl: string }, overrides: Record<string, string> = {}) {
    const url = new URL(start.authorizationUrl);
    nonce = url.searchParams.get('nonce')!; expectedVerifierChallenge = url.searchParams.get('code_challenge')!; expectedRedirect = url.searchParams.get('redirect_uri')!;
    const callback = new URL(expectedRedirect);
    callback.search = new URLSearchParams({ code: 'fixture-code', state: url.searchParams.get('state')!, client_id: 'fixture-issued-client', ...overrides }).toString();
    return fetch(callback);
  }, async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
