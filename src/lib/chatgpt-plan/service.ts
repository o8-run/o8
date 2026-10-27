import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { OsPlanStore } from './credential-store';
import { readDesktopAccountEpoch } from '@/lib/auth/desktop-plan-binding';
import { ChatGPTPlanError, PLAN_SCOPE, PLAN_SCOPES, PLAN_USAGE_URL, type PlanModel, type PlanRecord, type PlanRegistration, type PlanSelection, type PlanStatus, type PlanStore, type PlanTokens } from './types';

interface IssuerConfig { issuer: string; authorization: string; token: string; jwks: string; revocation: string; resource: string }
interface Attempt {
  owner: string; generation: number; state: string; nonce: string; verifier: string;
  redirectUri: string; registration: PlanRegistration | null; server: Server;
  expiresAt: number; consumed: boolean; stateName: 'waiting' | 'ready' | 'failed';
  error?: ChatGPTPlanError; ready?: PlanRegistration; timer: ReturnType<typeof setTimeout>;
  desktopEpoch: string;
}

const PRODUCTION: IssuerConfig = {
  issuer: 'https://auth.openai.com', authorization: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token', jwks: 'https://auth.openai.com/.well-known/jwks.json',
  revocation: 'https://auth.openai.com/api/accounts/oauth/revoke', resource: 'https://api.openai.com/v1',
};
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const opaque = () => randomBytes(32).toString('base64url');

export function planError(code: unknown, status = 502): ChatGPTPlanError {
  const value = typeof code === 'string' && /^[a-z_]{1,100}$/.test(code) ? code : 'plan_request_failed';
  const messages: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: 'Your ChatGPT plan limit for this connection was reached. Manage usage in ChatGPT to continue.',
    subscription_sharing_user_not_eligible: 'ChatGPT plan use is unavailable for this account or workspace.',
    subscription_sharing_usage_unavailable: 'ChatGPT could not check plan usage. Try again later.',
    subscription_sharing_invalid_user: 'The ChatGPT connection needs to be checked. Reconnect after confirming disconnection.',
    subscription_sharing_unsupported_capability: 'This request uses a capability unavailable through ChatGPT plan sign-in.',
    subscription_sharing_route_not_supported: 'ChatGPT plan use is unavailable on this route.',
  };
  return new ChatGPTPlanError(value, messages[value] ?? 'The ChatGPT plan request stopped. No other billing route was used.', status);
}

/** Endpoints are internal configuration, never accepted from HTTP callers. */
export class ChatGPTPlanService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  private readonly requests = new Map<string, Set<AbortController>>();

  constructor(private readonly store: PlanStore, private readonly config: IssuerConfig = PRODUCTION) {
    this.keys = createRemoteJWKSet(new URL(config.jwks), { timeoutDuration: 5_000 });
  }

  private async form(endpoint: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new ChatGPTPlanError('provider_unavailable', 'ChatGPT could not be reached. No other billing route was used.', 503); }
    if (endpoint === this.config.revocation && response.ok) return {};
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw planError(typeof data.error === 'string' ? data.error : (data.error as Record<string, unknown> | undefined)?.code, response.status);
    return data;
  }

  private async tokens(data: Record<string, unknown>, clientId: string, nonce?: string, subject?: string): Promise<{ tokens: PlanTokens; identity: JWTPayload }> {
    if (data.token_type !== 'Bearer' || typeof data.access_token !== 'string' || !data.access_token
      || typeof data.refresh_token !== 'string' || !data.refresh_token || typeof data.id_token !== 'string'
      || typeof data.scope !== 'string' || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
      throw new ChatGPTPlanError('invalid_token_response', 'ChatGPT returned an incomplete connection.', 502);
    }
    let identity: JWTPayload;
    try {
      ({ payload: identity } = await jwtVerify(data.id_token, this.keys, { issuer: this.config.issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 }));
      if (!identity.sub || (nonce !== undefined && identity.nonce !== nonce) || (subject && identity.sub !== subject)) throw new Error();
    } catch { throw new ChatGPTPlanError('identity_mismatch', 'The ChatGPT sign-in did not match this connection.', 403); }
    return { identity, tokens: { accessToken: data.access_token, refreshToken: data.refresh_token, idToken: data.id_token, expiresAt: Date.now() + data.expires_in * 1_000, scopes: data.scope.split(/\s+/).filter(Boolean) } };
  }

  async start(owner: string, accountId?: string): Promise<{ attemptId: string; authorizationUrl: string }> {
    const desktopEpoch = readDesktopAccountEpoch(owner);
    return this.store.locked(owner, async () => {
      const record = await this.store.read(owner);
      const registration = accountId ? record.registrations.find((entry) => entry.id === accountId) : null;
      if (accountId && !registration) throw new ChatGPTPlanError('account_missing', 'Choose a ChatGPT connection belonging to this o8 account.', 404);
      record.generation += 1;
      await this.store.write(owner, record);
      for (const [id, pending] of this.attempts) if (pending.owner === owner) this.closeAttempt(id);
      const id = opaque();
      const state = opaque(); const nonce = opaque(); const verifier = opaque();
      const server = createServer((request, response) => {
        let url: URL;
        try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
        catch { response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid request.'); return; }
        if (request.method !== 'GET' || url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
        void this.callback(id, url).then(() => {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' });
          response.end('<p>Return to o8 to finish connecting your ChatGPT plan.</p>');
        }).catch(() => { response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('This sign-in could not be completed. Return to o8 and try again.'); });
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); throw new ChatGPTPlanError('callback_unavailable', 'The desktop sign-in callback could not start.', 503); }
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const timer = setTimeout(() => this.closeAttempt(id), 5 * 60_000); timer.unref();
      this.attempts.set(id, { owner, generation: record.generation, state, nonce, verifier, redirectUri, registration: registration ?? null, server, expiresAt: Date.now() + 5 * 60_000, consumed: false, stateName: 'waiting', timer, desktopEpoch });
      const url = new URL(this.config.authorization);
      url.search = new URLSearchParams({ client_id: registration?.clientId ?? 'dynamic_agent_client', ...(!registration ? { agent_name_hint: 'o8' } : {}), ext_agent_host_id: await this.store.hostId(), response_type: 'code', redirect_uri: redirectUri, scope: PLAN_SCOPES, resource: this.config.resource, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
      return { attemptId: id, authorizationUrl: url.toString() };
    });
  }

  private closeAttempt(id: string): void {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    clearTimeout(attempt.timer); attempt.server.close(); attempt.ready = undefined;
    this.attempts.delete(id);
  }

  private attempt(owner: string, id: string): Attempt {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.owner !== owner || attempt.expiresAt < Date.now()) throw new ChatGPTPlanError('attempt_expired', 'Start a new ChatGPT sign-in.', 404);
    return attempt;
  }

  async attemptStatus(owner: string, id: string): Promise<{ state: string }> {
    const attempt = this.attempt(owner, id);
    if (attempt.error) throw attempt.error;
    return { state: attempt.stateName };
  }

  private async callback(id: string, url: URL): Promise<void> {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.consumed || attempt.expiresAt < Date.now()
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== attempt.state) {
      throw new ChatGPTPlanError('callback_invalid', 'The sign-in response did not match this attempt.', 403);
    }
    attempt.consumed = true;
    try {
      if (url.searchParams.has('error')) throw new ChatGPTPlanError('consent_declined', 'ChatGPT plan access was not enabled.');
      const clientId = url.searchParams.get('client_id') ?? attempt.registration?.clientId;
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.getAll('code').length !== 1 || !clientId || clientId === 'dynamic_agent_client'
        || url.searchParams.getAll('client_id').length > 1 || (attempt.registration && clientId !== attempt.registration.clientId)) {
        throw new ChatGPTPlanError('callback_invalid', 'The ChatGPT registration did not match this attempt.', 403);
      }
      await this.store.locked(attempt.owner, async () => {
        if (readDesktopAccountEpoch(attempt.owner) !== attempt.desktopEpoch) throw new ChatGPTPlanError('attempt_cancelled', 'The o8 account changed during sign-in.');
        const record = await this.store.read(attempt.owner);
        if (record.generation !== attempt.generation) throw new ChatGPTPlanError('attempt_cancelled', 'This sign-in was cancelled.');
        let registration = attempt.registration;
        if (!registration) {
          registration = { id: randomUUID(), issuer: this.config.issuer, subject: '', clientId, label: 'ChatGPT account', tokens: null };
          record.registrations.push(registration);
          // Retain the issued client even if code exchange fails; do not create
          // another registration on an ordinary retry.
          await this.store.write(attempt.owner, record);
        }
        const data = await this.form(this.config.token, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: this.config.resource });
        const verified = await this.tokens(data, clientId, attempt.nonce, registration.subject);
        if (readDesktopAccountEpoch(attempt.owner) !== attempt.desktopEpoch) throw new ChatGPTPlanError('attempt_cancelled', 'The o8 account changed during sign-in.');
        attempt.ready = { ...registration, subject: verified.identity.sub!, label: typeof verified.identity.email === 'string' ? verified.identity.email : 'ChatGPT account', tokens: verified.tokens };
        attempt.stateName = 'ready';
      });
    } catch (error) {
      attempt.stateName = 'failed';
      attempt.error = error instanceof ChatGPTPlanError ? error : new ChatGPTPlanError('sign_in_failed', 'ChatGPT sign-in could not finish.', 502);
      throw attempt.error;
    } finally { attempt.server.close(); }
  }

  async finish(owner: string, id: string): Promise<void> {
    await this.store.locked(owner, async () => {
      const attempt = this.attempt(owner, id);
      const record = await this.store.read(owner);
      if (readDesktopAccountEpoch(owner) !== attempt.desktopEpoch) throw new ChatGPTPlanError('attempt_cancelled', 'The o8 account changed during sign-in.');
      if (!attempt.ready || record.generation !== attempt.generation) throw new ChatGPTPlanError('attempt_cancelled', 'This sign-in is not ready or was cancelled.');
      record.registrations = record.registrations.map((entry) => entry.id === attempt.ready!.id ? attempt.ready! : entry);
      record.activeId = attempt.ready.id;
      await this.store.write(owner, record);
      this.closeAttempt(id);
    });
  }

  private async active(owner: string, record: PlanRecord): Promise<PlanRegistration> {
    const account = record.registrations.find((entry) => entry.id === record.activeId);
    if (!account?.tokens) throw new ChatGPTPlanError('plan_disconnected', 'Connect your ChatGPT plan in Settings → Models.', 401);
    if (account.tokens.refreshUncertain) throw new ChatGPTPlanError('refresh_uncertain', 'The previous ChatGPT renewal was interrupted. Reconnect this account before starting another request.', 409);
    if (!account.tokens.scopes.includes(PLAN_SCOPE)) throw new ChatGPTPlanError('plan_permission_required', 'Enable ChatGPT plan use for this connection before starting inference.', 403);
    if (account.tokens.expiresAt <= Date.now() + 30_000) {
      account.tokens.refreshUncertain = true;
      await this.store.write(owner, record);
      try {
        const data = await this.form(this.config.token, { grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.tokens.refreshToken, resource: this.config.resource });
        const verified = await this.tokens(data, account.clientId, undefined, account.subject);
        account.tokens = verified.tokens;
        await this.store.write(owner, record);
      } catch (error) {
        if (error instanceof ChatGPTPlanError && TERMINAL_REFRESH.has(error.code)) {
          account.tokens = null; record.generation += 1; await this.store.write(owner, record);
          throw new ChatGPTPlanError('plan_disconnected', 'Your ChatGPT connection expired or was disconnected. Connect it again.', 401);
        }
        // A definite issuer refusal did not rotate the token. A transport
        // failure may have rotated it: retain the credential but hold replay.
        if (error instanceof ChatGPTPlanError && error.status < 500 && ['invalid_client', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type'].includes(error.code)) {
          account.tokens!.refreshUncertain = false; await this.store.write(owner, record);
        }
        throw error;
      }
    }
    if (!account.tokens!.scopes.includes(PLAN_SCOPE)) throw new ChatGPTPlanError('plan_permission_required', 'ChatGPT plan permission was not renewed.', 403);
    return account;
  }

  private async modelsFor(account: PlanRegistration): Promise<PlanModel[]> {
    let response: Response;
    try { response = await fetch(`${this.config.resource}/models`, { headers: { Authorization: `Bearer ${account.tokens!.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new ChatGPTPlanError('provider_unavailable', 'ChatGPT models could not be loaded.', 503); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw planError(data.error?.code, response.status);
    if (!Array.isArray(data.models)) throw new ChatGPTPlanError('models_invalid', 'ChatGPT returned an invalid model list.', 502);
    return data.models.filter((model: Record<string, unknown>) => model.visibility === 'list' && typeof model.slug === 'string').map((model: { slug: string; display_name?: string }) => ({ id: model.slug, label: model.display_name || model.slug }));
  }

  async status(owner: string): Promise<PlanStatus> {
    const desktopEpoch = readDesktopAccountEpoch(owner);
    return this.store.locked(owner, async () => {
      const record = await this.store.read(owner);
      let account = record.registrations.find((entry) => entry.id === record.activeId);
      const enabled = Boolean(account?.tokens?.scopes.includes(PLAN_SCOPE));
      let models: PlanModel[] = [];
      let modelLoadError: string | undefined;
      if (enabled) { try { account = await this.active(owner, record); models = await this.modelsFor(account); } catch (error) { modelLoadError = error instanceof ChatGPTPlanError ? error.message : 'ChatGPT models could not be loaded.'; } }
      if (readDesktopAccountEpoch(owner) !== desktopEpoch) throw new ChatGPTPlanError('o8_session_changed', 'The o8 account changed while loading the connection.', 409);
      const planEnabled = Boolean(account?.tokens?.scopes.includes(PLAN_SCOPE)) && !account?.tokens?.refreshUncertain;
      return { connected: Boolean(account?.tokens), planEnabled, activeId: record.activeId, welcomed: record.welcomed, accounts: record.registrations.map((entry) => ({ id: entry.id, label: entry.label, connected: Boolean(entry.tokens) })), models, usageUrl: PLAN_USAGE_URL, ...(planEnabled && account ? { selection: { accountId: account.id, generation: record.generation, desktopEpoch } } : {}), ...(modelLoadError ? { modelLoadError } : {}) };
    });
  }

  async select(owner: string, id: string): Promise<void> {
    for (const request of this.requests.get(owner) ?? []) request.abort();
    await this.store.locked(owner, async () => {
      const record = await this.store.read(owner);
      if (!record.registrations.some((entry) => entry.id === id && entry.tokens)) throw new ChatGPTPlanError('plan_disconnected', 'Reconnect this ChatGPT account before selecting it.', 401);
      record.activeId = id; record.generation += 1; await this.store.write(owner, record);
    });
  }

  async welcome(owner: string): Promise<void> {
    await this.store.locked(owner, async () => { const record = await this.store.read(owner); record.welcomed = true; await this.store.write(owner, record); });
  }

  async disconnect(owner: string, id?: string): Promise<{ revocationConfirmed: boolean }> {
    for (const request of this.requests.get(owner) ?? []) request.abort();
    return this.store.locked(owner, async () => {
      const record = await this.store.read(owner);
      const account = record.registrations.find((entry) => entry.id === (id ?? record.activeId));
      const tokens = account?.tokens;
      if (account) account.tokens = null;
      record.generation += 1;
      // Clear locally before contacting the issuer. A failed revocation cannot
      // restore inference or a pending sign-in through a delayed refresh.
      await this.store.write(owner, record);
      for (const [attemptId, attempt] of this.attempts) if (attempt.owner === owner) this.closeAttempt(attemptId);
      if (!tokens || !account) return { revocationConfirmed: true };
      try { await this.form(this.config.revocation, { client_id: account.clientId, token: tokens.refreshToken, token_type_hint: 'refresh_token' }); return { revocationConfirmed: true }; }
      catch { return { revocationConfirmed: false }; }
    });
  }

  async selection(owner: string): Promise<PlanSelection> {
    const desktopEpoch = readDesktopAccountEpoch(owner);
    return this.store.locked(owner, async () => {
      const record = await this.store.read(owner);
      const account = record.registrations.find((entry) => entry.id === record.activeId);
      if (!account?.tokens) throw new ChatGPTPlanError('plan_disconnected', 'Connect your ChatGPT plan in Settings → Models.', 401);
      if (readDesktopAccountEpoch(owner) !== desktopEpoch) throw new ChatGPTPlanError('o8_session_changed', 'The o8 account changed before this turn.', 409);
      return { accountId: account.id, generation: record.generation, desktopEpoch };
    });
  }

  async toolAdmission<T>(owner: string, selection: PlanSelection, action: () => Promise<T>): Promise<T> {
    return this.store.locked(owner, async () => {
      const record = await this.store.read(owner);
      if (readDesktopAccountEpoch(owner) !== selection.desktopEpoch) throw new ChatGPTPlanError('o8_session_changed', 'The o8 account changed before this tool could run.', 409);
      const account = record.registrations.find((entry) => entry.id === record.activeId);
      if (record.activeId !== selection.accountId || record.generation !== selection.generation || !account?.tokens?.scopes.includes(PLAN_SCOPE) || account.tokens.refreshUncertain) {
        throw new ChatGPTPlanError('plan_selection_changed', 'The ChatGPT connection changed before this tool could run.', 409);
      }
      return action();
    });
  }

  /** Bind every continuation to the same chosen account, with no payer switch. */
  async infer(owner: string, model: string, body: Record<string, unknown>, signal?: AbortSignal, selection?: PlanSelection): Promise<Response> {
    const desktopEpoch = selection?.desktopEpoch ?? readDesktopAccountEpoch(owner);
    if (readDesktopAccountEpoch(owner) !== desktopEpoch) throw new ChatGPTPlanError('o8_session_changed', 'The o8 account changed before this continuation.', 409);
    const controller = new AbortController();
    const requests = this.requests.get(owner) ?? new Set<AbortController>();
    this.requests.set(owner, requests); requests.add(controller);
    const combined = AbortSignal.any([controller.signal, signal ?? AbortSignal.timeout(120_000)]);
    try { return await this.store.locked(owner, async () => {
      const record = await this.store.read(owner);
      if (readDesktopAccountEpoch(owner) !== desktopEpoch) throw new ChatGPTPlanError('o8_session_changed', 'The o8 account changed before this continuation.', 409);
      if (selection && (record.activeId !== selection.accountId || record.generation !== selection.generation)) throw new ChatGPTPlanError('plan_selection_changed', 'The ChatGPT connection changed. Start a new turn with the chosen account.', 409);
      const account = await this.active(owner, record);
      if (!(await this.modelsFor(account)).some((entry) => entry.id === model)) throw new ChatGPTPlanError('model_unavailable', 'Choose a model available to the selected ChatGPT account.', 400);
      if (readDesktopAccountEpoch(owner) !== desktopEpoch) throw new ChatGPTPlanError('o8_session_changed', 'The o8 account changed before inference.', 409);
      let response: Response;
      try { response = await fetch(`${this.config.resource}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${account.tokens!.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model, store: false, stream: true }), redirect: 'error', signal: combined }); }
      catch { throw new ChatGPTPlanError('provider_unavailable', 'The ChatGPT plan request could not be admitted. No other billing route was used.', 503); }
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw planError(data.error?.code, response.status); }
      const reader = response.body?.getReader();
      if (!reader) throw new ChatGPTPlanError('stream_incomplete', 'ChatGPT returned no response stream.', 502);
      return new Response(new ReadableStream<Uint8Array>({
        async pull(stream) { try { const result = await reader.read(); if (result.done) { requests.delete(controller); stream.close(); } else stream.enqueue(result.value); } catch (error) { requests.delete(controller); stream.error(error); } },
        async cancel() { requests.delete(controller); controller.abort(); await reader.cancel().catch(() => {}); },
      }), { headers: response.headers, status: response.status });
    }); } catch (error) { requests.delete(controller); throw error; }
  }
}

let service: ChatGPTPlanService | null = null;
export function getChatGPTPlanService(): ChatGPTPlanService { return service ??= new ChatGPTPlanService(new OsPlanStore()); }
