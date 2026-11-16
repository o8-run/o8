#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const mode = process.env.O8_CLAUDE_CAPACITY_TEST_MODE;
const audit = process.env.O8_CLAUDE_CAPACITY_TEST_AUDIT;
if (audit) appendFileSync(audit, `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null })}\n`);
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (audit) appendFileSync(audit, `${JSON.stringify(row)}\n`);
  if (row.type !== 'control_request') process.exit(3);
  if (mode === 'timeout') return;
  if (row.request.subtype === 'get_status' && mode === 'no-status') {
    const refusal = `${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: row.request_id, error: 'Unsupported control request subtype: get_status' } })}\n`;
    queue = queue.then(() => { process.stdout.write(refusal); });
    return;
  }
  const payload = row.request.subtype === 'initialize' ? {} : row.request.subtype === 'get_status' ? {
    sections: [{ title: 'Session', rows: [{ label: 'Version', value: '2.1.0' }, { label: 'Organization', value: 'Example Org' }, { label: 'Email', value: 'private@example.invalid' }] }],
  } : {
    rate_limits_available: mode !== 'unsupported',
    rate_limits: mode === 'unsupported' ? null : {
      five_hour: { utilization: mode === 'malformed' ? 110 : 15, resets_at: '2026-10-09T01:50:00Z' },
      seven_day: { utilization: 59, resets_at: '2026-10-14T12:00:00Z' },
      model_scoped: [{ display_name: 'Example model', utilization: 22, resets_at: null }],
      spend: { enabled: true, used: { amount_minor: 420, currency: 'USD', exponent: 2 }, limit: { amount_minor: 5000, currency: 'USD', exponent: 2 }, balance: { amount_minor: 1250, currency: 'USD', exponent: 2 } },
      cedar_ember: { eligible: true, next_grant_id: 'g1', grants: [{ id: 'g1', resets_left: 2, usable_now: true, ends_at: null }] },
    },
    subscription_type: 'private-plan', account_email: 'private@example.invalid',
  };
  // Split writes exercise the actual stream buffer and request correlation.
  const text = `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: row.request_id, response: payload } })}\n`;
  // Queued so two answers in flight never interleave inside one line.
  queue = queue.then(() => new Promise(done => {
    process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'unrelated', response: {} } })}\n`);
    process.stdout.write(text.slice(0, 17));
    setTimeout(() => { process.stdout.write(text.slice(17)); done(); }, 5);
  }));
});
