#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.161.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using fixture'); process.exit(0); }
if (args[0] !== 'exec') process.exit(0);
const root = join(dirname(fileURLToPath(import.meta.url)), 'sessions');
const resume = args[1] === 'resume';
const threadId = resume ? args[2] : randomUUID();
const path = join(root, threadId + '.json');
const argument = args.at(-1);
const record = message => appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ resume, threadId, message,
  transport: argument === '-' ? 'stdin' : 'argv', model: args.find(arg => arg.startsWith('model='))?.slice(6) }) + '\n');
const controlPath = join(root, 'control.json');
const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
if (!resume && control.waitOnFresh) {
  record(argument);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (!resume && control.allocateWithoutInput) {
  writeFileSync(path, '');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
  record(argument);
  if (control.allocateWithoutInput === 'failure') {
    console.error('Error: fixture input was not accepted');
    process.exit(1);
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if ((resume && !existsSync(path)) || control.refuseFresh) {
  record(argument);
  if (control.streamFirst) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Partial answer' } }));
  if (control.waitForInterrupt) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  console.error('Error: thread/resume failed: no rollout found for thread id ' + threadId);
  process.exit(1);
}
let message = argument;
if (argument === '-') {
  message = '';
  for await (const chunk of process.stdin) message += chunk.toString();
}
record(message);
const context = (resume ? readFileSync(path, 'utf8') : '') + '\n' + message;
writeFileSync(path, context);
const answer = context.includes('widget-731') && context.includes('copper')
  ? 'widget-731 / copper' : 'Earlier facts are unavailable';
console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
