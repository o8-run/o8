/** Synthetic Clerk verification and existing ChatGPT provider fixture; no auth checks replaced. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPlanFixture, FixturePlanStore } from '../../tests/helpers/chatgpt-plan-fixture';

class IsolatedPlanStore extends FixturePlanStore {
  private readonly queues = new Map<string, Promise<void>>();
  override async locked<T>(owner: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(owner, next);
    await previous;
    try { return await action(); }
    finally { release(); if (this.queues.get(owner) === next) this.queues.delete(owner); }
  }
}

export async function seedInboxPlanFixture(repo: string, dataDir: string, bearer: string, receipt: string) {
  const owner = 'user_inbox_fixture';
  const issuer = 'https://fixture-clerk.example.invalid';
  const pair = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'inbox-fixture', alg: 'RS256' };
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from('fixture-clerk.example.invalid$').toString('base64')}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    return nativeFetch(input, init);
  };
  const session = async (subject = owner, sid = 'session_inbox', expired = false) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid, azp: 'https://o8.run' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(issuer).setSubject(subject).setIssuedAt(now - 120).setNotBefore(now - 120)
      .setExpirationTime(expired ? now - 60 : now + 600).sign(pair.privateKey);
  };
  const valid = await session();
  const headers = { authorization: `Bearer ${bearer}`, 'x-clerk-session-token': valid, 'content-type': 'application/json' };
  const { bindDesktopAccount } = await import('../../src/lib/auth/desktop-account');
  await bindDesktopAccount(new Request('http://127.0.0.1/api/panel/models/chatgpt', { headers }));
  const fixture = await createPlanFixture(new IsolatedPlanStore(dataDir));
  const { getChatGPTPlanService } = await import('../../src/lib/chatgpt-plan/service');
  // Swap only the provider endpoints/credential-store instance, retaining the real service methods.
  const service = getChatGPTPlanService();
  if (!['store', 'config', 'keys'].every((key) => Object.hasOwn(service, key) && Object.hasOwn(fixture.service, key))) throw new Error('Plan fixture service shape changed');
  Object.assign(service, fixture.service);
  const start = await fixture.service.start(owner);
  await fixture.authorize(start);
  await fixture.service.finish(owner, start.attemptId);
  const { POST } = await import('../../src/app/api/v2/proxy/llm/route');
  const { getApproval } = await import('../../src/lib/approvals/store');
  const approvals = [];
  for (const tabId of ['inbox-plan-native', 'inbox-plan-desktop']) {
    fixture.control.responseMode = 'approval';
    fixture.control.toolName = 'write_file';
    const response = await POST(new NextRequest('http://127.0.0.1/api/v2/proxy/llm', { method: 'POST',
      headers: { ...headers, 'x-tab-id': tabId }, body: JSON.stringify({ provider: 'chatgpt', model: 'fixture-plan-model',
        repoPath: repo, tabId, messages: [{ role: 'user', content: 'Make the bounded fixture edit.' }], disableTools: false }) }));
    const event = (await response.text()).split('\n').filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as { type?: string; id?: string }).find((entry) => entry.type === 'approval_required');
    const approval = event?.id ? getApproval(event.id) : null;
    if (!approval) throw new Error('Plan approval fixture did not reach the persisted queue');
    approvals.push(approval);
  }
  writeFileSync(receipt, JSON.stringify({ valid, expired: await session(owner, 'session_inbox', true),
    wrongOwner: await session('user_other'), wrongSession: await session(owner, 'session_other'),
    nativeId: approvals[0].id, desktopId: approvals[1].id, file: join(repo, 'fixture.txt') }), { mode: 0o600 });
  return { approvals, beforeDecision: () => { fixture.control.responseMode = 'approval'; },
    close: async () => { await fixture.close(); globalThis.fetch = nativeFetch; } };
}
