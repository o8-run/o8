// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSION_CARD_HOLD_MS, type MissionCardView, type TaskArtifactTarget } from '@/lib/task-artifacts/types';
import { MissionCard } from './MissionCard';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const target: TaskArtifactTarget = { kind: 'thread', repoPath: '/repo', threadId: 'thoughts-1', packetId: null, laneId: null, sessionKey: null };
const open: MissionCardView = {
  id: 'tart-00000000-0000-4000-8000-000000000001',
  title: 'Merge cards packet?',
  createdAt: '2026-11-04T10:00:00.000Z',
  kind: 'approve',
  body: 'Tests are green.',
  actions: [
    { id: 'approve', label: 'Approve', style: 'primary', confirm: 'hold' },
    { id: 'deny', label: 'Deny', style: 'danger' },
  ],
  entityIds: ['packet:pkt-1'],
  expiresAt: '2026-11-05T10:00:00.000Z',
  state: 'open',
  reason: null,
  receipt: null,
  summary: null,
};
const decided: MissionCardView = {
  ...open,
  state: 'decided',
  receipt: { actionId: 'approve', actionLabel: 'Approve', entityIds: ['packet:pkt-1'], decidedBy: 'operator', decidedAt: '2026-11-04T10:01:00.000Z', receiptId: 'tact-1', delivery: 'accepted' },
  summary: 'Approve · Merge cards packet? · by operator at 10:01 UTC',
};

function render(props: Partial<Parameters<typeof MissionCard>[0]> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const onDeliverToThread = props.onDeliverToThread ?? vi.fn(() => true);
  const onDecided = props.onDecided ?? vi.fn();
  act(() => root!.render(createElement(MissionCard, {
    card: props.card ?? open, target: props.target ?? target, threadBusy: props.threadBusy ?? false, onDeliverToThread, onDecided,
  })));
  return { onDeliverToThread, onDecided };
}

const button = (id: string) => host!.querySelector<HTMLButtonElement>(`[data-testid="mission-card-action-${id}"]`)!;
const press = (element: HTMLElement, type: 'pointerdown' | 'pointerup') => {
  element.dispatchEvent(new Event(type, { bubbles: true }));
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('classic mission card', () => {
  it('draws the card with its typed actions and entity ids', () => {
    render();
    expect(host!.querySelector('[data-testid="mission-card"]')?.getAttribute('data-card-kind')).toBe('approve');
    expect(host!.textContent).toContain('Merge cards packet?');
    expect(host!.textContent).toContain('packet:pkt-1');
    expect(button('approve').textContent).toBe('Hold to approve');
    expect(button('deny').textContent).toBe('Deny');
  });

  it('a hold shorter than the confirm time decides nothing; a full hold sends card.decision and rides the thread turn', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
      accepted: true, deliverVia: 'thread', action: { id: 'tact-1' }, wireMessage: 'wire', displayMessage: 'Approve · Merge cards packet?', card: decided,
    } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { onDeliverToThread, onDecided } = render();

    act(() => press(button('approve'), 'pointerdown'));
    act(() => { vi.advanceTimersByTime(MISSION_CARD_HOLD_MS - 100); });
    act(() => press(button('approve'), 'pointerup'));
    act(() => { vi.advanceTimersByTime(MISSION_CARD_HOLD_MS); });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => press(button('approve'), 'pointerdown'));
    await act(async () => { vi.advanceTimersByTime(MISSION_CARD_HOLD_MS); });
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/task-artifacts/${open.id}/decision`);
    expect(JSON.parse(init.body as string)).toMatchObject({ actionId: 'approve', entityIds: ['packet:pkt-1'] });
    expect(onDeliverToThread).toHaveBeenCalledWith({ artifactId: open.id, actionId: 'tact-1', wireMessage: 'wire', displayMessage: 'Approve · Merge cards packet?' });
    expect(onDecided).toHaveBeenCalled();
    const receipt = host!.querySelector('[data-testid="mission-card-receipt"]');
    expect(receipt?.getAttribute('data-card-state')).toBe('decided');
    expect(receipt?.textContent).toBe(decided.summary);
  });

  it('a decided or expired card renders only its one-line receipt', () => {
    render({ card: { ...open, state: 'expired', summary: 'Expired · Merge cards packet? · no decision by 10:00 UTC' } });
    expect(host!.querySelector('[data-testid="mission-card"]')).toBeNull();
    expect(host!.querySelector('[data-testid="mission-card-receipt"]')?.textContent).toBe('Expired · Merge cards packet? · no decision by 10:00 UTC');
  });

  it('a busy thread holds the decision back', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render({ threadBusy: true });
    await act(async () => { button('deny').click(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host!.querySelector('[role="alert"]')?.textContent).toMatch(/busy/);
  });
});
