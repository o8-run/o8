import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/mcp/route';

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await POST(new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  expect(response.status).toBe(200);
  return (await response.json()).result;
}

describe('agent call guidance through MCP discovery and calls', () => {
  it('publishes every required review finding field and its allowed severity values', async () => {
    const { tools } = await rpc('tools/list');
    const review = tools.find((tool: { name: string }) => tool.name === 'submit_review');
    const finding = review.inputSchema.properties.findings.items;
    expect(finding.required).toEqual(['file', 'severity', 'description', 'status']);
    expect(finding.properties.severity.enum).toEqual(['bug', 'rule_violation', 'note']);
    expect(review.description).toContain('Required: packetId, findings, approved');
  });

  it('gives lease units, defaults, and a complete example without another lookup', async () => {
    const { tools } = await rpc('tools/list');
    const lease = tools.find((tool: { name: string }) => tool.name === 'o8_lease_acquire');
    expect(lease.inputSchema.properties.ttlMs.default).toBe(7_200_000);
    expect(lease.inputSchema.properties.wait.default).toBe(false);
    expect(lease.inputSchema.properties.resource.description).toContain('o8_lease_release');
    expect(lease.description).toContain('o8_lease_acquire({resource: "audit", ttlMs: 60000, wait: false})');
  });

  it('publishes mission input requirements and the immediate-dispatch default', async () => {
    const { tools } = await rpc('tools/list');
    const mission = tools.find((tool: { name: string }) => tool.name === 'create_mission');
    expect(mission.inputSchema.required).toEqual(['repoPath']);
    expect(mission.inputSchema.properties.issues).toMatchObject({ minItems: 1, items: { type: 'string' } });
    expect(mission.inputSchema.properties.issues_inline.minItems).toBe(1);
    expect(mission.inputSchema.properties.dispatch.default).toBe(true);
    expect(mission.description).toContain('issues: ["495", "496"]');
    expect(mission.description).toContain('dispatch:false');
  });

  it('names the field and lists replacements for an invalid review severity', async () => {
    const result = await rpc('tools/call', { name: 'submit_review', arguments: {
      packetId: 'audit-packet', approved: false,
      findings: [{ file: 'src/example.ts', severity: 'urgent', description: 'Check behavior', status: 'deferred' }],
    } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Failed to submit review: Unsupported finding severity: urgent. Set severity to bug, rule_violation, or note.');
  });

  it('rejects an ambiguous lease wait flag before acquiring anything', async () => {
    const result = await rpc('tools/call', { name: 'o8_lease_acquire', arguments: { resource: 'audit', wait: 'true' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool error: wait must be a boolean. Set wait:true to queue, or wait:false to return immediately.');
  });

  it('explains how to repair a missing required string', async () => {
    const result = await rpc('tools/call', { name: 'o8_lease_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('o8_lease_status failed: resource is required. Set resource to a non-empty string.');
  });

  it('rejects a non-object arguments value at the transport entry point', async () => {
    const result = await rpc('tools/call', { name: 'o8_lease_list', arguments: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('arguments must be an object. Set arguments to an object such as {}.');
  });

  it('points an unavailable-tool caller back to discovery', async () => {
    const result = await rpc('tools/call', { name: 'lease_acquire', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool unavailable in operator MCP profile full: lease_acquire. Call tools/list and use an available name exactly.');
  });
});
