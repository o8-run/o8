/** Explicit local configuration of a network transcript, not a join or delivery endpoint. */
import { readFileSync } from 'node:fs';
import { closeDb } from '../src/lib/db';
import { createNetworkThread } from '../src/lib/bots/network-store';
import { projectNetworkThread } from '../src/lib/bots/network-projection';

try {
  const command = JSON.parse(readFileSync(0, 'utf8')) as { bindingIds: string[]; conversationId?: string; threadId?: string };
  const thread = createNetworkThread(command);
  projectNetworkThread(thread.threadId);
  process.stdout.write(`${JSON.stringify(thread)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Network thread configuration failed.'}\n`);
  process.exitCode = 1;
} finally { closeDb(); }
