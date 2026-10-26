/** Offline read-only replay: inputs are timestamped canonical snapshots, never guessed historical states. */
import { readFileSync } from 'node:fs';
import { replayThreadModels, type ThreadReplaySnapshot } from '../../../src/lib/threads/grouping';
const input = process.argv[2];
if (!input) throw new Error('Usage: npx tsx scripts/bench/interactions/thread-model-replay.ts <snapshots.json>');
const snapshots = JSON.parse(readFileSync(input, 'utf8')) as ThreadReplaySnapshot[];
if (!Array.isArray(snapshots) || snapshots.some(snapshot => !Number.isFinite(Date.parse(snapshot.at)) || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.attentionIds))) throw new Error('Expected timestamped thread snapshots and independently recorded attentionIds.');
process.stdout.write(`${JSON.stringify({ snapshots: snapshots.length, first: snapshots[0]?.at ?? null, last: snapshots.at(-1)?.at ?? null, models: replayThreadModels(snapshots) }, null, 2)}\n`);
