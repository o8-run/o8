import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('skips review screenshot logs only when the bridge is absent', async () => {
  const { getDataDir } = await import('@/lib/data-dir-migration');
  const dataDir = getDataDir();
  const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
  const { O8WebviewClient } = await import('@/lib/mcp/o8-webview-client');
  const { WebviewBridgeError } = await import('@/lib/mcp/o8-webview-error');
  const screenshot = vi.spyOn(O8WebviewClient.prototype, 'screenshot');
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const enterReview = (label: string) => {
    const lane = createLane({ repoPath: dataDir, branch: label, runtime: 'codex', baseCommit: 'a'.repeat(40) });
    setLaneStatus(lane.id, 'reviewing', 'system', 'fixture-review', { reason: 'fixture boundary' });
    const event = getLaneEvents(lane.id).find(candidate => candidate.verb === 'status_change')!;
    expect(event.payload).toEqual({ status: 'reviewing', eventLabel: 'fixture-review', reason: 'fixture boundary' });
    return { lane, event };
  };
  try {
    vi.stubEnv('O8_TAURI_MCP_SOCKET', '');
    const unconfigured = enterReview('fixture-no-socket');
    await Promise.resolve();
    expect(screenshot).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
    expect(getLaneEvents(unconfigured.lane.id).find(event => event.id === unconfigured.event.id)).toEqual(unconfigured.event);

    vi.stubEnv('O8_TAURI_MCP_SOCKET', join(dataDir, 'fixture-unused-webview.sock'));
    screenshot.mockRejectedValueOnce(new WebviewBridgeError('webview_bridge_missing'));
    const missing = enterReview('fixture-no-bridge');
    await Promise.resolve();
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
    expect(getLaneEvents(missing.lane.id).find(event => event.id === missing.event.id)).toEqual(missing.event);

    const rejected = new WebviewBridgeError('webview_auth_rejected');
    screenshot.mockRejectedValueOnce(rejected);
    const auth = enterReview('fixture-auth-rejected');
    await Promise.resolve();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(`[lane-registry] Failed to capture review screenshot for lane ${auth.lane.id}:`, rejected);
    expect(warningLog).not.toHaveBeenCalled();
    expect(getLaneEvents(auth.lane.id).find(event => event.id === auth.event.id)).toEqual(auth.event);
  } finally {
    screenshot.mockRestore(); errorLog.mockRestore(); warningLog.mockRestore(); vi.unstubAllEnvs();
  }
});
