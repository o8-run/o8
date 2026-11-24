import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface MintResponse {
  schema: string;
  ok: boolean;
  token: {
    id: string;
    label: string | null;
    repoGrants: string[];
    createdAt: string;
    revokedAt: string | null;
  };
  bearer: string;
}

interface RevokeResponse {
  schema: string;
  ok: boolean;
  token: MintResponse['token'];
}

interface PostResponse {
  schema: string;
  ok: boolean;
  event: {
    id: string;
    kind: 'commentary' | 'conversation' | 'focus';
    actor: string;
    audience?: string | null;
    text?: string;
    title?: string | null;
    goal?: string | null;
    issue?: number | null;
    startedAt?: string | null;
    cleared?: boolean;
    timestamp: string;
  };
}

interface AutomationSayResponse {
  schema: string;
  ok: boolean;
  result: {
    status: 'recorded' | 'duplicate' | 'ignored';
    eventId: string | null;
    reason: string | null;
  };
}

function readFlag(rest: string[], name: string): string | null {
  const index = rest.indexOf(name);
  if (index < 0) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliError('invalid_args', `${name} requires a value.`, EXIT.INVALID_ARGS);
  }
  return value;
}

function readFlags(rest: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== name) continue;
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CliError('invalid_args', `${name} requires a value.`, EXIT.INVALID_ARGS);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function positional(rest: string[], valueFlags: ReadonlySet<string>): string[] {
  const output: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('--')) output.push(value);
  }
  return output;
}

function broadcastUrl(apiBase: string, bearer: string): string {
  const url = new URL('/broadcast', apiBase);
  url.hash = `token=${encodeURIComponent(bearer)}`;
  return url.toString();
}

export async function runBroadcast(
  mode: OutputMode,
  group: string | undefined,
  rest: string[],
): Promise<number> {
  if (group === 'automation-say') {
    const textArgs = positional(rest, new Set());
    if (textArgs.length !== 1 || rest.some((value) => value.startsWith('--'))) {
      throw new CliError(
        'invalid_args',
        'Use `o8 broadcast automation-say "<text>"` from a running automation packet.',
        EXIT.INVALID_ARGS,
      );
    }
    const cfg = resolveConfig();
    const response = await apiFetch<AutomationSayResponse>(cfg, '/api/broadcast/automation-say', {
      method: 'POST',
      body: { text: textArgs[0] },
    });
    if (!response.data) {
      throw new CliError('invalid_response', 'Broadcast automation-say returned no data.', EXIT.INVALID_ARGS);
    }
    const payload = {
      schema: 'o8/cli/broadcast.automation-say/v1',
      ok: true,
      ...response.data.result,
    };
    if (mode.human) {
      printHumanHeading('Scheduled Symon attention');
      printHumanKv([
        ['status', payload.status],
        ['event', payload.eventId ?? '(none)'],
        ['reason', payload.reason ?? '(none)'],
      ]);
    } else {
      printJson(payload);
    }
    return EXIT.OK;
  }

  if (group === 'focus') {
    const allowedFlags = new Set(['--goal', '--issue', '--clear']);
    const unknownFlag = rest.find((value) => value.startsWith('--') && !allowedFlags.has(value));
    if (unknownFlag) {
      throw new CliError('unknown_flag', `Unknown broadcast focus flag: ${unknownFlag}`, EXIT.INVALID_ARGS);
    }
    const clear = rest.includes('--clear');
    const goal = readFlag(rest, '--goal');
    const issueValue = readFlag(rest, '--issue');
    const titleArgs = positional(rest, new Set(['--goal', '--issue']));
    const issue = issueValue === null ? null : Number(issueValue);
    if (
      (clear && (rest.length !== 1 || rest[0] !== '--clear'))
      || (!clear && titleArgs.length !== 1)
      || (issue !== null && (!Number.isSafeInteger(issue) || issue < 1))
    ) {
      throw new CliError(
        'invalid_args',
        'Use `o8 broadcast focus "<title>" [--goal "<text>"] [--issue N]` or `o8 broadcast focus --clear`.',
        EXIT.INVALID_ARGS,
      );
    }
    const cfg = resolveConfig();
    const response = await apiFetch<PostResponse>(cfg, '/api/broadcast/post', {
      method: 'POST',
      body: clear
        ? { kind: 'focus', clear: true }
        : { kind: 'focus', title: titleArgs[0], goal, issue },
    });
    if (!response.data) throw new CliError('invalid_response', 'Broadcast focus returned no data.', EXIT.INVALID_ARGS);
    const payload = {
      schema: 'o8/cli/broadcast.focus/v1',
      ok: true,
      event: response.data.event,
    };
    if (mode.human) {
      printHumanHeading(clear ? 'Broadcast focus cleared' : 'Broadcast focus');
      printHumanKv([
        ['id', payload.event.id],
        ['title', payload.event.title ?? '(cleared)'],
        ['issue', payload.event.issue ? `#${payload.event.issue}` : '(none)'],
      ]);
    } else {
      printJson(payload);
    }
    return EXIT.OK;
  }

  if (group === 'post') {
    const allowedFlags = new Set(['--kind', '--as', '--to']);
    const unknownFlag = rest.find((value) => value.startsWith('--') && !allowedFlags.has(value));
    if (unknownFlag) {
      throw new CliError('unknown_flag', `Unknown broadcast post flag: ${unknownFlag}`, EXIT.INVALID_ARGS);
    }
    const kind = readFlag(rest, '--kind');
    const actor = readFlag(rest, '--as');
    const audience = readFlag(rest, '--to');
    const textArgs = positional(rest, allowedFlags);
    if ((kind !== 'commentary' && kind !== 'conversation') || !actor || textArgs.length !== 1) {
      throw new CliError(
        'invalid_args',
        'Broadcast post requires --kind commentary|conversation, --as <actor>, and one text argument.',
        EXIT.INVALID_ARGS,
      );
    }
    const cfg = resolveConfig();
    const response = await apiFetch<PostResponse>(cfg, '/api/broadcast/post', {
      method: 'POST',
      body: { kind, actor, audience, text: textArgs[0] },
    });
    if (!response.data) throw new CliError('invalid_response', 'Broadcast post returned no data.', EXIT.INVALID_ARGS);
    const payload = {
      schema: 'o8/cli/broadcast.post/v1',
      ok: true,
      event: response.data.event,
    };
    if (mode.human) {
      printHumanHeading('Broadcast post');
      printHumanKv([
        ['id', payload.event.id],
        ['kind', payload.event.kind],
        ['actor', payload.event.actor],
        ['audience', payload.event.audience ?? '(all)'],
      ]);
    } else {
      printJson(payload);
    }
    return EXIT.OK;
  }

  if (group !== 'token') {
    throw new CliError(
      'unknown_broadcast_subcommand',
      `Unknown broadcast subcommand: ${group ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Use `o8 broadcast automation-say ...`, `o8 broadcast focus ...`, `o8 broadcast post ...`, or `o8 broadcast token mint|revoke ...`.',
    );
  }
  const [action, ...args] = positional(rest, new Set(['--label', '--repo']));
  if (action !== 'mint' && action !== 'revoke') {
    throw new CliError(
      'unknown_broadcast_token_action',
      `Unknown broadcast token action: ${action ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Use `o8 broadcast token mint [--label name] [--repo remote|path|name:<repo>]` or `o8 broadcast token revoke <id>`.',
    );
  }
  const unknownFlag = rest.find((value) => (
    value.startsWith('--') && value !== '--label' && value !== '--repo'
  ));
  if (unknownFlag) {
    throw new CliError('unknown_flag', `Unknown broadcast token flag: ${unknownFlag}`, EXIT.INVALID_ARGS);
  }
  const cfg = resolveConfig();
  if (action === 'mint') {
    if (args.length > 0) {
      throw new CliError('invalid_args', 'Broadcast token mint accepts no positional arguments.', EXIT.INVALID_ARGS);
    }
    const repoGrants = readFlags(rest, '--repo');
    const response = await apiFetch<MintResponse>(cfg, '/api/broadcast/tokens', {
      method: 'POST',
      body: {
        action: 'mint',
        label: readFlag(rest, '--label'),
        ...(repoGrants.length > 0 ? { repoGrants } : {}),
      },
    });
    if (!response.data) throw new CliError('invalid_response', 'Broadcast token mint returned no data.', EXIT.INVALID_ARGS);
    const payload = {
      schema: 'o8/cli/broadcast.token.mint/v1',
      ok: true,
      token: {
        ...response.data.token,
        repoGrants: response.data.token.repoGrants ?? [],
      },
      bearer: response.data.bearer,
      url: broadcastUrl(cfg.apiBase, response.data.bearer),
    };
    if (mode.human) {
      printHumanHeading('Broadcast spectator token');
      printHumanKv([
        ['id', payload.token.id],
        ['label', payload.token.label ?? '(none)'],
        ['repository grants', payload.token.repoGrants.length > 0
          ? payload.token.repoGrants.join(', ')
          : '(broadcast only)'],
        ['bearer', payload.bearer],
        ['url', payload.url],
      ]);
      process.stdout.write('\nSave this bearer now. o8 stores only its hash.\n');
    } else {
      printJson(payload);
    }
    return EXIT.OK;
  }

  const id = args[0];
  if (!id || args.length !== 1 || readFlag(rest, '--label') || readFlags(rest, '--repo').length > 0) {
    throw new CliError('invalid_args', 'Broadcast token revoke requires exactly one token id.', EXIT.INVALID_ARGS);
  }
  const response = await apiFetch<RevokeResponse>(cfg, '/api/broadcast/tokens', {
    method: 'POST',
    body: { action: 'revoke', id },
  });
  if (!response.data) throw new CliError('invalid_response', 'Broadcast token revoke returned no data.', EXIT.INVALID_ARGS);
  const payload = {
    schema: 'o8/cli/broadcast.token.revoke/v1',
    ok: true,
    token: response.data.token,
  };
  if (mode.human) {
    printHumanHeading('Broadcast token revoked');
    printHumanKv([
      ['id', payload.token.id],
      ['revoked', payload.token.revokedAt ?? 'now'],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}
