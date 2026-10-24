import 'server-only';
import { getSqlite } from '@/lib/db';
import { githubInstallationFetch } from '@/lib/github-broker/auth';
import { getLane } from '@/lib/lane/registry';
import { packetRuleThread } from './session-merge-restriction';

/** Capture immutable provider identity at publication, never from a reusable cached address. */
export async function recordConversationPrDelivery(laneId: string, providerUrl: string) {
  const lane = getLane(laneId);
  const thread = packetRuleThread(lane?.packetId);
  let url: URL; try { url = new URL(providerUrl); } catch { return; }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/);
  if (!lane || lane.ownership !== 'managed' || !lane.packetId || !thread || !/^thoughts-[A-Za-z0-9_-]{1,120}$/.test(thread)
    || url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || !match || Number(match[2]) !== lane.prNumber) return;
  const db = getSqlite();
  const existing = db.prepare('SELECT packet_id, thread_id, provider_url FROM conversation_pr_delivery_intents WHERE lane_id = ?').get(laneId) as
    { packet_id: string; thread_id: string; provider_url: string } | undefined;
  if (existing) {
    if (existing.packet_id !== lane.packetId || existing.thread_id !== thread || existing.provider_url.toLowerCase() !== url.href.toLowerCase()) {
      throw new Error('Conversation delivery ownership changed.');
    }
    if (db.prepare("SELECT 1 FROM conversation_pr_context WHERE source = 'packet' AND source_key = ?").get(laneId)) return;
    // A later lookup of a reused URL cannot authenticate the original publication.
    throw new Error('Conversation delivery identity was not verified at publication.');
  }
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO conversation_pr_delivery_intents (lane_id,packet_id,thread_id,repository_name,number,provider_url,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(lane.id, lane.packetId, thread, match[1], lane.prNumber, url.href, createdAt);
  const { response } = await githubInstallationFetch(match[1], `/repos/${match[1]}/pulls/${lane.prNumber}`,
    { signal: AbortSignal.timeout(5_000) }, { share: false });
  if (!response.ok) throw new Error('Could not verify the published pull request identity.');
  const identity = await response.json() as { id?: number; number?: number; html_url?: string; base?: { repo?: { id?: number } } } | null;
  const repositoryId = identity?.base?.repo?.id;
  const pullRequestId = identity?.id;
  if (!Number.isSafeInteger(repositoryId) || !repositoryId || repositoryId < 1
    || !Number.isSafeInteger(pullRequestId) || !pullRequestId || pullRequestId < 1
    || identity?.number !== lane.prNumber || identity?.html_url?.toLowerCase() !== url.href.toLowerCase()) {
    throw new Error('Published pull request identity does not match its delivery URL.');
  }
  const current = getLane(laneId);
  if (current?.ownership !== 'managed' || current.packetId !== lane.packetId || current.prNumber !== lane.prNumber
    || packetRuleThread(current.packetId) !== thread) throw new Error('Conversation delivery ownership changed during verification.');
  getSqlite().prepare(`INSERT INTO conversation_pr_context
    (thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,source_key,packet_id,lane_id,created_at)
    VALUES (?,'github.com',?,?,?,?,'delivery','packet',?,?,?,?) ON CONFLICT DO NOTHING`)
    .run(thread, repositoryId, pullRequestId, lane.prNumber, match[1], lane.id, lane.packetId, lane.id, createdAt);
}
