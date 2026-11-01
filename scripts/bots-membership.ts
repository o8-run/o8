/** Local operator maintenance; no network listener or external enrollment. */
import { readFileSync } from 'node:fs';
import { applyLocalBotMembershipCommand } from '../src/lib/agents/bot-membership-commands';
import { closeDb } from '../src/lib/db';

try {
  const input = readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Membership command exceeds 1 MiB.');
  const result = applyLocalBotMembershipCommand(JSON.parse(input));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Local membership command failed.'}\n`);
  process.exitCode = 1;
} finally { closeDb(); }
