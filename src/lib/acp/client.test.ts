import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient, AcpRequestError, mapAcpUpdate, mapStopReason, type AcpRawNotification } from './client';

const children: AcpClient[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mapAcpUpdate', () => {
  it('maps text and thinking chunks', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }))
      .toEqual({ type: 'text', text: 'hello' });
    expect(mapAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me think' } }))
      .toEqual({ type: 'thinking', text: 'let me think' });
  });

  it('maps tool calls and completed results', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Read utils.py',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'utils.py' },
    })).toEqual({ type: 'tool_use', id: 'c1', name: 'Read utils.py', input: { path: 'utils.py' } });
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'def add' } }],
    })).toEqual({ type: 'tool_result', id: 'c1', name: '', output: 'def add' });
  });

  it('ignores non-terminal and unknown update variants', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'usage_update', size: 256_000, used: 27_021 })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'plan', entries: [] })).toBeNull();
    expect(mapAcpUpdate(null)).toBeNull();
    expect(mapAcpUpdate('nope')).toBeNull();
    expect(mapAcpUpdate({})).toBeNull();
  });

  it('handles missing chunk content without throwing', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk' })).toEqual({ type: 'text', text: '' });
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: 42 })).toEqual({ type: 'text', text: '' });
  });
});

describe('mapStopReason', () => {
  it('maps refusal to an error and other stops to completion', () => {
    expect(mapStopReason('refusal', 'sess-1').type).toBe('error');
    expect(mapStopReason('end_turn', 'sess-1')).toEqual({ type: 'done', sessionId: 'sess-1', cost: null });
    expect(mapStopReason('max_tokens', 'sess-2')).toEqual({ type: 'done', sessionId: 'sess-2', cost: null });
    expect(mapStopReason('cancelled', null)).toEqual({ type: 'done', sessionId: null, cost: null });
  });
});

describe('AcpClient', () => {
  it('boots the ACP process in the requested repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'o8-acp-cwd-'));
    tempDirs.push(cwd);
    const peer = String.raw`
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line);
          const result = request.method === 'initialize'
            ? { protocolVersion: 1 }
            : request.method === 'session/new'
              ? { sessionId: 'session-cwd', configOptions: [{ id: 'model', currentValue: process.cwd() }] }
              : request.method === 'session/set_config_option'
                ? {}
                : null;
          const response = result === null
            ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }
            : { jsonrpc: '2.0', id: request.id, result };
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      });
    `;
    const client = new AcpClient({ runtimeId: 'acp', command: process.execPath, args: ['-e', peer], cwd });
    children.push(client);

    await client.initialize();
    const session = await client.newSession(cwd);
    await expect(client.setModel(session.sessionId, 'provider/current-model')).resolves.toBeUndefined();

    expect(session.configOptions[0]?.currentValue).toBe(realpathSync(cwd));
  });

  it('answers agent permission requests and exposes raw notifications', async () => {
    const notifications: AcpRawNotification[] = [];
    const peer = String.raw`
      process.stdin.setEncoding('utf8');
      let buffer = '';
      let promptRequest = null;
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }) + '\n');
          } else if (message.method === 'session/new') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-permission' } }) + '\n');
          } else if (message.method === 'session/prompt') {
            promptRequest = message;
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 'permission-1',
              method: 'session/request_permission',
              params: { sessionId: 'session-permission', options: [{ optionId: 'allow-once' }] },
            }) + '\n');
          } else if (message.id === 'permission-1' && message.result?.outcome?.optionId === 'allow-once') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: 'session-permission', update: { sessionUpdate: 'usage_update', used: 10 } },
            }) + '\n');
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: promptRequest.id,
              result: { stopReason: 'end_turn' },
            }) + '\n');
          }
        }
      });
    `;
    const client = new AcpClient({ runtimeId: 'acp',
      command: process.execPath,
      args: ['-e', peer],
      onNotification: (notification) => notifications.push(notification),
      onRequest: (request) => {
        expect(request.method).toBe('session/request_permission');
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      },
    });
    children.push(client);

    await client.initialize();
    const session = await client.newSession(process.cwd());
    await expect(client.prompt(session.sessionId, 'Use a tool')).resolves.toBe('end_turn');

    expect(notifications).toEqual([{
      method: 'session/update',
      params: {
        sessionId: 'session-permission',
        update: { sessionUpdate: 'usage_update', used: 10 },
      },
    }]);
  });

  it('resumes and closes a durable session through the stabilized lifecycle methods', async () => {
    const peer = String.raw`
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line);
          const result = request.method === 'initialize'
            ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } }
            : request.method === 'session/resume'
              ? { configOptions: [{ id: 'mode', currentValue: 'build' }] }
              : request.method === 'session/close'
                ? {}
                : null;
          const response = result === null
            ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }
            : { jsonrpc: '2.0', id: request.id, result };
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      });
    `;
    const client = new AcpClient({ runtimeId: 'acp', command: process.execPath, args: ['-e', peer] });
    children.push(client);

    await client.initialize();
    await expect(client.resumeSession('durable-session', process.cwd())).resolves.toEqual({
      sessionId: 'durable-session',
      configOptions: [{
        id: 'mode',
        name: undefined,
        category: undefined,
        type: undefined,
        currentValue: 'build',
        options: [],
      }],
    });
    await expect(client.closeSession('durable-session')).resolves.toBeUndefined();
  });

  it('bounds requests when an ACP process stops responding', async () => {
    const peer = String.raw`
      process.stdin.resume();
    `;
    const client = new AcpClient({ runtimeId: 'acp',
      command: process.execPath,
      args: ['-e', peer],
      requestTimeoutMs: 25,
    });
    children.push(client);

    await expect(client.initialize()).rejects.toThrow('ACP initialize timed out after 25ms');
  });

  it('returns typed errors when a reverse request is rejected synchronously', async () => {
    const peer = String.raw`
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'unsupported-1', method: 'extension/unknown' }) + '\n');
          } else if (message.id === 'unsupported-1' && message.error?.code === -32601) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n');
          }
        }
      });
    `;
    const client = new AcpClient({ runtimeId: 'acp',
      command: process.execPath,
      args: ['-e', peer],
      onRequest: (request) => {
        throw new AcpRequestError(-32601, `Unsupported: ${request.method}`);
      },
    });
    children.push(client);

    await expect(client.initialize()).resolves.toMatchObject({ protocolVersion: 1 });
  });
});

it('streams progress immediately without saved secrets, before the peer can complete its prompt', async () => {
  let received!: () => void;
  const progress = new Promise<void>(resolve => { received = resolve; });
  let finished = false;
  const peer = String.raw`
    const send = value => process.stdout.write(JSON.stringify(value) + '\n');
    let pending;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'session/prompt') {
        pending = r.id;
        return send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'live',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working on it'}}}});
      }
      send({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:1}:r.method==='session/new'?{sessionId:'live'}:{}});
      if (r.method === 'session/set_config_option') send({jsonrpc:'2.0',id:pending,result:{stopReason:'end_turn'}});
    });
    setTimeout(() => process.exit(0), 5000).unref();
  `;
  const client = new AcpClient({ runtimeId: 'acp', command: process.execPath, args: ['-e', peer],
    onEvent: event => { if (event.type === 'text' && event.text === 'Working on it') received(); } });
  children.push(client);
  await client.initialize(); await client.newSession(process.cwd());
  const prompt = client.prompt('live', 'Fixture progress.').then(() => { finished = true; });
  await progress;
  expect(finished).toBe(false);
  await client.setModel('live', 'fixture'); await prompt;
});
