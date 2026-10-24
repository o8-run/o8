import { expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('./shared', async original => ({ ...await original<typeof import('./shared')>(), apiFetch: api }));
import { STANDING_LANE_HANDLERS, STANDING_LANE_TOOLS } from './standing-lanes';
it('exposes the complete standing lane surface with flat MCP objects', async () => {
  expect(STANDING_LANE_TOOLS).toHaveLength(8);
  for (const tool of STANDING_LANE_TOOLS) {
    expect(tool.inputSchema.type).toBe('object');
    api.mockResolvedValue({ ok: true, result: { laneId: 'lane-fixture' } });
    const result = await STANDING_LANE_HANDLERS[tool.name]({ laneId: 'lane-fixture' });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('lane-fixture') });
  }
});
