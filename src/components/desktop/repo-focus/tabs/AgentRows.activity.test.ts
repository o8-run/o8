import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { PacketRow } from './AgentRows';

const now = Date.UTC(2026, 0, 1, 12);
const ages = [
  { age: 0, activity: 'now', finished: 'just now' },
  { age: 120_000, activity: '2m ago', finished: '2m ago' },
  { age: 7_200_000, activity: '2h ago', finished: '2h ago' },
];

afterEach(() => vi.restoreAllMocks());

describe.each(['running', 'merged', 'archived', 'failed'] as const)('%s worker row activity', (status) => {
  it.each(ages)('describes activity at $age ms without claiming run duration', ({ age, activity, finished }) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const packet = {
      id: 'activity-row', title: 'Worker activity', status,
      releaseState: status === 'merged' ? 'released' : status === 'archived' ? 'archived' : 'pending',
      lastEventAt: new Date(now - 86_400_000).toISOString(),
      lane: { lastEventAt: new Date(now - age).toISOString() },
    } as OrchestratorPacket;
    const html = renderToStaticMarkup(createElement(PacketRow, { packet, active: false }));
    const expected = status === 'running' ? activity : `${status} ${finished}`;

    expect(html).toContain(` · ${expected}</span>`);
    expect(html).not.toMatch(/now elapsed|now ago|\belapsed\b/);
    expect(html).toContain('min-height:56px');
  });
});
