import 'server-only';
import { getSqlite } from '@/lib/db';
import { getLane } from '@/lib/lane/registry';
import { packetRuleThread } from './session-merge-restriction';
/** Called only after the real delivery path recorded its primary PR. No branch inference. */
export function recordConversationPrDelivery(laneId: string, providerUrl: string) {
  const lane = getLane(laneId);
  const thread = packetRuleThread(lane?.packetId);
  let url: URL; try { url = new URL(providerUrl); } catch { return; }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/);
  if (!lane || lane.ownership !== 'managed' || !lane.packetId || !thread || !/^thoughts-[A-Za-z0-9_-]{1,120}$/.test(thread)
    || url.origin !== 'https://github.com' || url.search || url.hash || !match || Number(match[2]) !== lane.prNumber) return;
  getSqlite().prepare(`INSERT INTO conversation_pr_delivery_intents (lane_id,packet_id,thread_id,repository_name,number,provider_url,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(lane_id) DO NOTHING`).run(lane.id, lane.packetId, thread, match[1], lane.prNumber, url.href, new Date().toISOString());
  // The durable intent survives a missing mirror and is enriched on the next read.
}

/** Bind provider immutable IDs only when the exact delivery URL has entered the trusted mirror. */
export function reconcileConversationPrDeliveries() {
  const db = getSqlite();
  db.prepare(`INSERT INTO conversation_pr_context
    (thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,source_key,packet_id,lane_id,created_at)
    SELECT d.thread_id,'github.com',p.repository_id,p.pull_request_id,d.number,d.repository_name,'delivery','packet',d.lane_id,d.packet_id,d.lane_id,d.created_at
    FROM conversation_pr_delivery_intents d JOIN github_pull_requests p ON p.repo_full_name = d.repository_name COLLATE NOCASE AND p.number = d.number AND p.url = d.provider_url COLLATE NOCASE
    WHERE p.repository_id > 0 AND p.pull_request_id > 0
      AND NOT EXISTS (SELECT 1 FROM conversation_pr_context c WHERE c.source = 'packet' AND c.source_key = d.lane_id)
    ON CONFLICT DO NOTHING`).run();
}
