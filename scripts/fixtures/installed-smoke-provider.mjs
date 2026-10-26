#!/usr/bin/env node
// Offline CLI edge. The installed app still owns routing, parsing and persistence.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const kind = process.argv[1].includes('claude') ? 'claude' : 'codex';
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const text = value => JSON.stringify(value).match(/o8_smoke_[a-f0-9-]+/)?.[0] ?? 'fixture-ready';
if (args.includes('--version') || args.includes('--help')) {
  console.log(kind === 'codex' ? 'codex-cli 0.163.0' : 'fixture 1.0.0');
} else if (args[0] === 'login' || args[0] === 'auth') {
  console.log('Logged in');
} else if (kind === 'codex' && args[0] === 'app-server') {
  let thread = randomUUID();
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (!message.method) return;
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      thread = message.params?.threadId ?? thread;
      emit({ id: message.id, result: { thread: { id: thread } } });
    } else if (message.method === 'turn/start') {
      const turn = randomUUID();
      const notify = (method, params) => emit({ method, params: { threadId: thread, turnId: turn, ...params } });
      emit({ id: message.id, result: { turn: { id: turn, status: 'inProgress' } } });
      notify('item/started', { item: { type: 'agentMessage', id: 'reply', text: '' } });
      notify('item/completed', { item: { type: 'agentMessage', id: 'reply', text: text(message.params) } });
      notify('turn/completed', { turn: { id: turn, status: 'completed' } });
    } else {
      emit({ id: message.id, result: {} });
    }
  });
} else if (kind === 'codex') {
  let prompt = args.join(' ');
  if (!prompt.includes('o8_smoke_') && args.includes('-')) prompt += readFileSync(0, 'utf8');
  emit({ type: 'thread.started', thread_id: randomUUID() });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: text(prompt) } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else {
  const session = randomUUID();
  const reply = input => {
    emit({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text: text(input) }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: text(input), usage: { input_tokens: 1, output_tokens: 1 } });
  };
  emit({ type: 'system', subtype: 'init', session_id: session });
  if (args.includes('--input-format')) createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'user') reply(message);
  });
  else reply(args.join(' '));
}
