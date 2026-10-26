// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OrchestratorDataValue } from '../orchestrator-data-context';
import { SessionTranscriptPane } from '../SessionTranscriptPane';
import * as actionReceipt from '@/lib/orchestrator/action-receipt';
import { resetComposerDraftMemoryForTests } from '../thoughts/chat-panel/composer-draft-store';

const context = vi.hoisted(() => ({ value: null as OrchestratorDataValue | null }));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => context.value }));

const transcriptMock = vi.hoisted(() => ({
  slice: {
    messages: [] as MobileTranscriptEntry[],
    status: 'fresh' as const,
    error: null,
  },
}));

vi.mock('@/lib/transcripts/useTranscript', () => ({
  useTranscript: () => transcriptMock.slice,
}));

vi.mock('./SessionTransformMenu', () => ({ SessionTransformMenu: () => null }));
const packetTranscriptMock = vi.hoisted(() => ({ entries: [] as MobileTranscriptEntry[], activity: null }));
vi.mock('./use-packet-transcript-poll', () => ({
  usePacketTranscriptPoll: () => packetTranscriptMock,
}));
vi.mock('./WorkspaceTranscript', () => ({
  WorkspaceTranscript: ({ entries }: { entries: MobileTranscriptEntry[] }) => createElement(
    'div',
    null,
    entries.map((entry) => entry.text).join(''),
  ),
}));

import {
  AgentTilePane,
  canSteerAgentState,
  classifyAgentTileStatus,
  normalizeAgentTileTranscript,
  resolveAgentTileStatus,
} from './AgentTilePane';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;
let resizeCallbacks: ResizeObserverCallback[] = [];

function flushAnimationFrame() {
  const pending = [...animationFrames.values()];
  animationFrames.clear();
  pending.forEach((callback) => callback(performance.now()));
}

beforeEach(() => {
  packetTranscriptMock.entries = [];
  localStorage.clear();
  resetComposerDraftMemoryForTests();
  animationFrames = new Map();
  nextAnimationFrame = 1;
  resizeCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = nextAnimationFrame;
    nextAnimationFrame += 1;
    animationFrames.set(frame, callback);
    return frame;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => {
    animationFrames.delete(frame);
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }

    observe() {}
    disconnect() {}
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  resetComposerDraftMemoryForTests();
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeAgentTileTranscript', () => {
  it('shows the assigned task instead of the injected worker envelope', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: [
        '## Project Brief',
        '',
        'Project: Workspace (0 repos)',
        '',
        '## Task',
        'Packet: Verify Codex setup',
        'Summary: Task inline-1: Verify Codex setup',
        '',
        'Add one verification step to README.md.',
        'Branch target: inline/demo',
        'Internal worker rules that should stay hidden.',
      ].join('\n'),
    }]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('Add one verification step to README.md.');
  });

  it('handles the flat prompt shape returned by owned runtime history', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: '## Project Brief Project: Workspace (0 repos) ## Task Packet: Verify Codex setup Summary: Task inline-1: Verify Codex setup Add one verification step to README.md. Branch target: inline/demo Internal worker rules.',
    }], 'Verify Codex setup');

    expect(entries[0]?.text).toBe('Add one verification step to README.md.');
  });

  it('prepends the operator task when an owned runtime history starts with agent output', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'assistant-1',
      role: 'assistant',
      text: 'I will inspect the repository now.',
    }], 'Verify live worker chat', {
      id: 'pkt-live-worker',
      text: 'Read README.md and report its first heading.',
    });

    expect(entries.map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'Read README.md and report its first heading.'],
      ['assistant', 'I will inspect the repository now.'],
    ]);
  });

  it('does not duplicate a task already present as the first user turn', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: 'Read README.md.',
    }], 'README check', {
      id: 'pkt-readme',
      text: 'Read README.md.',
    });

    expect(entries).toHaveLength(1);
  });
});

describe('AgentTilePane live transcript scrolling', () => {
  it('follows a growing entry across frames and yields after the operator scrolls up', () => {
    const renderPane = (text: string) => {
      transcriptMock.slice.messages = [{ id: 'assistant-live', role: 'assistant', text }];
      act(() => {
        root?.render(createElement(AgentTilePane, {
          sessionKey: 'codex-owned:live-worker',
          agent: { name: 'Worker', status: 'running', runtime: 'codex' },
          focused: true,
          onClose: () => {},
          onFocus: () => {},
        }));
      });
    };

    renderPane('Starting');
    const scroller = host?.querySelector('.cortex-scroll-fade-y') as HTMLDivElement | null;
    expect(scroller).not.toBeNull();
    if (!scroller) return;

    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_000);

    scrollHeight = 1_100;
    renderPane('Starting and continuing');
    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_100);

    scrollHeight = 1_200;
    renderPane('Starting and continuing across another frame');
    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_200);

    scrollHeight = 1_300;
    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });
    expect(scroller.scrollTop).toBe(1_300);

    act(() => {
      scroller.scrollTop = 600;
      scroller.dispatchEvent(new Event('scroll'));
    });
    scrollHeight = 1_400;
    renderPane('More output that must not yank the operator back down');
    act(flushAnimationFrame);
    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });
    expect(scroller.scrollTop).toBe(600);

    act(() => {
      scroller.scrollTop = 1_000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    scrollHeight = 1_500;
    renderPane('Pinning resumes after the operator returns to the bottom');
    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_500);
  });
});

describe('AgentTilePane unsent worker drafts', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const textarea = () => host!.querySelector<HTMLTextAreaElement>('textarea')!;
  async function show(sessionKey = 'codex-owned:draft-a') {
    await act(async () => root!.render(createElement(AgentTilePane, {
      sessionKey, agent: { name: 'Worker', status: 'running', runtime: 'codex' },
      focused: true, onClose: vi.fn(), onFocus: vi.fn(),
    })));
  }
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text);
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const sends = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/runtime/action');
  beforeEach(() => {
    fetchMock = vi.fn(async () => Response.json({ agents: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('retains unsent addressed input after a worker pane is closed and reopened without sending it', async () => {
    await show(); await type('Check the compact layout before continuing.');
    await act(async () => root!.render(null)); await show();
    expect(textarea().value).toBe('Check the compact layout before continuing.');
    expect(sends()).toHaveLength(0);
  });

  it('restores the exact unsent input after reloading the draft store', async () => {
    await show(); await type('  Keep line one.\nKeep line two.  ');
    await act(async () => root!.render(null));
    resetComposerDraftMemoryForTests();
    await show();
    expect(textarea().value).toBe('  Keep line one.\nKeep line two.  ');
    expect(sends()).toHaveLength(0);
  });

  it('isolates drafts by exact session when the same pane changes workers', async () => {
    await show(); await type('Only for worker A');
    await show('codex-owned:draft-b'); expect(textarea().value).toBe('');
    await type('Only for worker B');
    await show(); expect(textarea().value).toBe('Only for worker A');
    await show('codex-owned:draft-b'); expect(textarea().value).toBe('Only for worker B');
    expect(sends()).toHaveLength(0);
  });

  it('keeps an explicitly cleared draft empty on reopen', async () => {
    await show(); await type('Discard this draft'); await type('');
    await act(async () => root!.render(null)); await show();
    expect(textarea().value).toBe(''); expect(sends()).toHaveLength(0);
  });

  it('warns when storage fails and retains the draft in memory across pane remounts', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    await show(); await type('Keep this window open.');
    expect(host!.querySelector('[data-worker-draft-warning]')?.textContent).toContain('Keep this window open');
    await act(async () => root!.render(null)); await show();
    expect(textarea().value).toBe('Keep this window open.');
    expect(host!.querySelector('[data-worker-draft-warning]')?.textContent).toContain('Keep this window open'); expect(sends()).toHaveLength(0);
  });

  it('retains a refused steer on reopening and still requires explicit submission', async () => {
    fetchMock.mockImplementation(async () => Response.json({ ok: false, error: 'Session unavailable.' }, { status: 409 }));
    await show(); await type('Retry this correction deliberately.');
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="composer-send-control"]')!.click());
    expect(textarea().value).toBe('Retry this correction deliberately.');
    await act(async () => root!.render(null)); await show();
    expect(textarea().value).toBe('Retry this correction deliberately.'); expect(sends()).toHaveLength(1);
  });

  it('does not let a late refusal replace a newer draft after the pane remounts', async () => {
    let refuse!: (response: Response) => void;
    fetchMock.mockImplementation((url: RequestInfo | URL) => String(url) === '/api/runtime/action'
      ? new Promise<Response>(resolve => { refuse = resolve; }) : Promise.resolve(Response.json({ agents: [] })));
    await show(); await type('Original correction');
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="composer-send-control"]')!.click());
    await act(async () => root!.render(null)); await show(); await type('Newer unsent correction');
    await act(async () => refuse(Response.json({ ok: false, error: 'Session unavailable.' }, { status: 409 })));
    expect(textarea().value).toBe('Newer unsent correction');
    await act(async () => root!.render(null)); await show();
    expect(textarea().value).toBe('Newer unsent correction'); expect(sends()).toHaveLength(1);
  });

  it('keeps another session draft when an earlier worker reply arrives after a session change', async () => {
    await show('codex-owned:draft-b'); await type('Existing worker B correction');
    let refuse!: (response: Response) => void;
    fetchMock.mockImplementation((url: RequestInfo | URL) => String(url) === '/api/runtime/action'
      ? new Promise<Response>(resolve => { refuse = resolve; }) : Promise.resolve(Response.json({ agents: [] })));
    await show(); await type('Worker A correction');
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="composer-send-control"]')!.click());
    await show('codex-owned:draft-b');
    expect(textarea().value).toBe('Existing worker B correction');
    await act(async () => refuse(Response.json({ ok: false, error: 'Session unavailable.' }, { status: 409 })));
    expect(textarea().value).toBe('Existing worker B correction');
    expect(sends()).toHaveLength(1);
  });
});

describe('AgentTilePane worker identity', () => {
  it('shows the task title and model with a short composer placeholder', () => {
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:worker',
        agent: { name: 'Worker', status: 'running', runtime: 'codex', model: 'gpt-6-sol', currentTask: 'Trace the handoff' },
        focused: true,
        onClose: () => {},
        onFocus: () => {},
      }));
    });

    expect(host?.querySelector('[data-worker-model]')?.textContent).toBe('· gpt-6-sol');
    expect(host?.querySelector('[data-worker-title]')?.textContent).toBe('Trace the handoff');
    expect(host?.querySelector('[data-worker-task]')).toBeNull();
    expect(host?.querySelector('[data-o8-composer-root]')).not.toBeNull();
    expect(host?.querySelector('[data-brain-dock-tab]')).toBeNull();
    expect(host?.querySelector('[data-testid="composer-send-control"]')).not.toBeNull();
    expect(host?.textContent).not.toContain('To @Worker · Steer');
    expect(host?.querySelector('textarea')?.getAttribute('placeholder')).toBe('Message this worker');
  });

  it('names the actual operator decision and opens the bound review', () => {
    const openReview = vi.fn();
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:review-worker',
        agent: { name: 'Worker', status: 'idle', runtime: 'codex' },
        packet: {
          id: 'packet-review', status: 'awaiting_review', title: 'Review the change',
          completionSummary: 'The implementation is ready.',
          explainer: { status: 'ready', changedFileCount: 3 },
        } as OrchestratorPacket,
        focused: true,
        onClose: () => {},
        onFocus: () => {},
        onOpenReview: openReview,
      }));
    });

    expect(host?.querySelector('[data-worker-outcome-card]')?.textContent).toContain('Needs review');
    expect(host?.querySelector('[data-worker-outcome]')?.textContent).toBe('The implementation is ready.');
    act(() => host?.querySelector<HTMLButtonElement>('[data-worker-open-review]')?.click());
    expect(openReview).toHaveBeenCalledOnce();
  });

  it('restores the steer text and shows a failed receipt when delivery is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/runtime/action') {
        return new Response(JSON.stringify({ ok: false, error: 'Session unavailable.' }), { status: 409 });
      }
      return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    }));
    vi.stubGlobal('crypto', { randomUUID: () => 'steer-test-id' });
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:steer-worker',
        agent: { name: 'Worker', status: 'running', runtime: 'codex' },
        focused: true,
        onClose: () => {},
        onFocus: () => {},
      }));
    });
    const textarea = host?.querySelector('textarea');
    const form = host?.querySelector('form');
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    if (!textarea || !form) return;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(textarea, 'Check the failing test.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(textarea.value).toBe('Check the failing test.');
    expect(host?.querySelector('[data-worker-steer-receipt]')?.textContent).toContain('Not sent');
    expect(host?.textContent).toContain('Session unavailable.');
  });

  it('checks an uncertain steer using the original mutation body', async () => {
    const receipt = vi.spyOn(actionReceipt, 'fetchCorrelatedActionReceipt')
      .mockRejectedValueOnce(new actionReceipt.CorrelatedActionUnsettledError())
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        payload: { ok: true },
      });
    const randomUUID = vi.fn(() => 'one-steer-id');
    vi.stubGlobal('crypto', { randomUUID });
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:steer-worker',
        agent: { name: 'Worker', status: 'running', runtime: 'codex' },
        focused: true,
        onClose: () => {},
        onFocus: () => {},
      }));
    });
    const textarea = host?.querySelector('textarea');
    const form = host?.querySelector('form');
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    if (!textarea || !form) return;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(textarea, 'Continue the verification.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host?.querySelector('[data-worker-steer-receipt]')?.textContent).toContain('Receipt unavailable');
    expect(textarea.disabled).toBe(true);
    await act(async () => {
      const check = [...(host?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Check receipt');
      check?.click();
    });
    expect(host?.querySelector('[data-worker-steer-receipt]')).toBeNull();
    expect(receipt).toHaveBeenCalledTimes(2);
    expect(receipt.mock.calls[0]?.[1]?.body).toBe(receipt.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(String(receipt.mock.calls[0]?.[1]?.body)).clientMutationId).toBe('one-steer-id');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('resumes a paused owned worker through the existing correlated steer route', async () => {
    const receipt = vi.spyOn(actionReceipt, 'fetchCorrelatedActionReceipt').mockResolvedValue({
      response: new Response('{}', { status: 200 }), payload: { ok: true },
    });
    act(() => root?.render(createElement(AgentTilePane, {
      sessionKey: 'codex-owned:paused-worker', agent: { name: 'Worker', status: 'paused', runtime: 'codex' },
      focused: true, onClose: () => {}, onFocus: () => {},
    })));
    const resume = [...(host?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Resume')!;
    await act(async () => { resume.click(); resume.click(); });
    expect(receipt).toHaveBeenCalledOnce();
    expect(JSON.parse(String(receipt.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: 'steer', surfaceId: 'codex-owned:paused-worker', message: 'Continue the assigned task.',
    });
  });

  it('checks an uncertain Stop with the same mutation and preserves the draft', async () => {
    const receipt = vi.spyOn(actionReceipt, 'fetchCorrelatedActionReceipt')
      .mockRejectedValueOnce(new actionReceipt.CorrelatedActionUnsettledError())
      .mockResolvedValueOnce({ response: new Response('{}', { status: 200 }), payload: { ok: true } });
    act(() => root?.render(createElement(AgentTilePane, {
      sessionKey: 'codex-owned:paused-worker', agent: { name: 'Worker', status: 'paused', runtime: 'codex' },
      focused: true, onClose: () => {}, onFocus: () => {},
    })));
    const textarea = host!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Keep this draft.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const stop = [...host!.querySelectorAll('button')].find(button => button.textContent === 'Stop')!;
    await act(async () => { stop.click(); stop.click(); });
    expect(receipt).toHaveBeenCalledOnce();
    expect(textarea.disabled).toBe(true);
    await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === 'Check receipt')!.click());
    expect(receipt).toHaveBeenCalledTimes(2);
    expect(receipt.mock.calls[0]?.[1]?.body).toBe(receipt.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(String(receipt.mock.calls[0]?.[1]?.body))).toMatchObject({ action: 'interrupt', surfaceId: 'codex-owned:paused-worker' });
    expect(textarea.value).toBe('Keep this draft.');
  });

  it('humanizes a branch-only packet and keeps a refused Stop visible when message entry is disabled', async () => {
    vi.spyOn(actionReceipt, 'fetchCorrelatedActionReceipt').mockResolvedValue({
      response: new Response('{}', { status: 409, statusText: 'Interrupt could not be confirmed.' }), payload: { ok: false },
    });
    act(() => root?.render(createElement(AgentTilePane, {
      sessionKey: 'codex-owned:blocked-worker', agent: { name: 'Worker', status: 'idle', runtime: 'codex' },
      packet: { id: 'blocked', title: '', branchTarget: 'issue/4080-check-ci', status: 'blocked', blockedReason: 'CI' } as OrchestratorPacket,
      focused: true, onClose: () => {}, onFocus: () => {},
    })));
    expect(host?.querySelector('[data-worker-title]')?.textContent).toBe('Check CI');
    expect(host?.querySelector('textarea')?.disabled).toBe(true);
    await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === 'Stop')!.click());
    expect(host?.querySelector('[data-worker-steer-receipt]')?.textContent).toContain('Interrupt could not be confirmed.');
  });
});

describe('classifyAgentTileStatus', () => {
  it('shows completed worker output as ready for review', () => {
    expect(classifyAgentTileStatus('awaiting_review')).toBe('review');
  });

  it('keeps a genuine failed transcript red', () => {
    expect(classifyAgentTileStatus('failed')).toBe('error');
  });

  it('shows an idle runtime with a huddle-blocked packet as waiting', () => {
    expect(resolveAgentTileStatus('idle', 'blocked', 'huddle_ready')).toBe('waiting');
  });

  it('keeps a runtime exit red even when the inventory has already gone idle', () => {
    expect(resolveAgentTileStatus('idle', 'blocked', 'runtime_process_exit')).toBe('error');
  });
});

describe('canSteerAgentState', () => {
  it('keeps completed owned conversations available without enabling unrelated external sessions or failed packets', () => {
    for (const sessionKey of ['codex-owned:one', 'claude-code-owned:two']) {
      expect(canSteerAgentState({ status: 'completed' }, null, sessionKey)).toBe(true);
      expect(canSteerAgentState({ status: 'idle' }, null, sessionKey)).toBe(true);
      expect(canSteerAgentState({ status: 'failed' }, null, sessionKey)).toBe(false);
      expect(canSteerAgentState({ status: 'completed' }, { status: 'failed' }, sessionKey)).toBe(false);
    }
    expect(canSteerAgentState({ status: 'completed' }, null, 'external:other')).toBe(false);
  });

  it('keeps the composer available for a huddle waiting on direction', () => {
    expect(canSteerAgentState(
      { status: 'idle' },
      { status: 'blocked', blockedReason: 'huddle_ready' },
    )).toBe(true);
  });

  it('does not present a steer composer for a failed worker', () => {
    expect(canSteerAgentState(
      { status: 'idle' },
      { status: 'failed', blockedReason: 'runtime_process_exit' },
    )).toBe(false);
  });

  it('offers the composer for an idle packet, which steers successfully (#1846)', () => {
    // The reported pane read `Codex · Codex · Idle` with no composer, while
    // steer_packet against that same packet resumed the worker and produced a
    // new commit. The pane was asserting a false state.
    expect(canSteerAgentState({ status: 'idle' }, { status: 'idle' })).toBe(true);
  });

  it('offers the composer while a packet is recovering between escalation layers', () => {
    expect(canSteerAgentState({ status: 'idle' }, { status: 'recovering' })).toBe(true);
  });

  it('still hides the composer where there is no session to steer', () => {
    expect(canSteerAgentState({ status: 'idle' }, { status: 'draft' })).toBe(false);
    expect(canSteerAgentState({ status: 'idle' }, { status: 'queued' })).toBe(false);
    expect(canSteerAgentState({ status: 'idle' }, { status: 'archived' })).toBe(false);
    expect(canSteerAgentState({ status: 'idle' }, { status: 'released' })).toBe(false);
    expect(canSteerAgentState(null, null)).toBe(false);
  });
});

it('opens review from the matching outcome card with its exact lane and repository, without merging', async () => {
  const openReview = vi.fn(); const request = vi.fn(async (_input: RequestInfo | URL) => Response.json({})); vi.stubGlobal('fetch', request);
  const packets = ['alpha', 'beta'].map(id => ({ id, title: `Work ${id}`, status: 'awaiting_review',
    lane: { laneId: `lane-${id}`, sessionKey: `session-${id}`, repoPath: `/projects/${id}` },
  } as OrchestratorPacket));
  context.value = { agents: [], missionState: { packets }, onOpenO8Panel: openReview } as unknown as OrchestratorDataValue;
  try {
    act(() => root?.render(createElement('div', null, ...packets.map(packet => createElement(SessionTranscriptPane, { key: packet.id, sessionKey: packet.lane!.sessionKey! })))));
    const headers = host!.querySelectorAll('[data-worker-outcome-card]');
    expect(headers).toHaveLength(2);
    act(() => headers[1].querySelector<HTMLButtonElement>('[data-worker-open-review]')!.click());
    expect(openReview).toHaveBeenCalledExactlyOnceWith({ tab: 'review', reviewLaneId: 'lane-beta', repoPath: '/projects/beta' });
    expect(request.mock.calls.some(call => String(call[0]).includes('/merge'))).toBe(false);
    context.value = { ...context.value, missionState: { packets: packets.map(packet => ({ ...packet, status: 'running' })) } } as OrchestratorDataValue;
    act(() => root?.render(createElement('div', null, ...packets.map(packet => createElement(SessionTranscriptPane, { key: packet.id, sessionKey: packet.lane!.sessionKey! })))));
    expect(host!.querySelector('[data-worker-pane-header] [data-worker-open-review]')).toBeNull();
  } finally { context.value = null; }
});


it.each([
  ['blocked', 'CI', 'Open checks'],
  ['blocked', 'worktree_conflict', 'Open details'],
  ['awaiting_review', undefined, 'Review'],
] as const)('opens the existing lane review surface from %s / %s with %s', (status, blockedReason, label) => {
  const openPanel = vi.fn();
  const packet = { id: 'state-action', title: 'Inspect the task', status, blockedReason,
    lane: { laneId: 'lane-state-action', sessionKey: 'session-state-action', repoPath: '/projects/frame' },
  } as OrchestratorPacket;
  context.value = { agents: [], missionState: { packets: [packet] }, onOpenO8Panel: openPanel } as unknown as OrchestratorDataValue;
  try {
    act(() => root?.render(createElement(SessionTranscriptPane, { sessionKey: 'session-state-action' })));
    if (status === 'awaiting_review') {
      expect(host!.querySelector('[data-worker-state-row]')).toBeNull();
      act(() => host!.querySelector<HTMLButtonElement>('[data-worker-outcome-card] [data-worker-open-review]')!.click());
    } else {
      const row = host!.querySelector('[data-worker-state-row]')!;
      expect([...row.querySelectorAll('button')].map(button => button.textContent)).toEqual([label, 'Stop']);
      expect(row.textContent).not.toContain('Resume');
      act(() => row.querySelector<HTMLButtonElement>(`[data-worker-state-action="${label}"]`)!.click());
    }
    expect(openPanel).toHaveBeenCalledExactlyOnceWith({ tab: 'review', reviewLaneId: 'lane-state-action', repoPath: '/projects/frame' });
  } finally { context.value = null; }
});

it('keeps a worker question answerable with only its state pill beside the composer', () => {
  act(() => root?.render(createElement(AgentTilePane, {
    sessionKey: 'codex-owned:question-worker', agent: { name: 'Worker', status: 'idle', runtime: 'codex' },
    packet: { id: 'question', title: 'Choose a recovery path', status: 'blocked', blockedReason: 'worker_question' } as OrchestratorPacket,
    focused: true, onClose: () => {}, onFocus: () => {}, onOpenReview: vi.fn(),
  })));
  const row = host!.querySelector('[data-worker-state-row]')!;
  expect(row.textContent).toBe('Waiting');
  expect(row.querySelectorAll('button')).toHaveLength(0);
  expect(host!.querySelector('textarea')!.disabled).toBe(false);
});


it('refreshes a mounted pane from review through running, closed and archived packet states', () => {
  const sessionKey = 'codex-owned:state-refresh';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agents: [] })));
  const packet = { id: 'state-refresh', title: 'Continue the task', status: 'awaiting_review',
    completionSummary: 'Earlier worker outcome', lane: { sessionKey } } as OrchestratorPacket;
  context.value = { agents: [{ sessionKey, name: 'Worker', status: 'reviewing', runtime: 'codex',
    statusEvidence: { sessionId: sessionKey, runtime: 'codex', state: 'review-ready', authority: 'runtime-event',
      observedAt: '2026-10-21T12:00:00.000Z', summary: 'Earlier worker outcome', evidence: [] } }],
    missionState: { packets: [packet] } } as unknown as OrchestratorDataValue;
  const render = () => act(() => root?.render(createElement(SessionTranscriptPane, { sessionKey })));
  render();
  expect(host?.querySelector('[data-worker-outcome]')?.textContent).toContain('Earlier worker outcome');
  for (const [status, label] of [['running', 'Running'], ['released', 'Complete'], ['archived', 'Archived']] as const) {
    context.value = { ...context.value, missionState: { packets: [{ ...packet, status }] } } as OrchestratorDataValue;
    render();
    expect(host?.querySelector('[data-worker-pane-header] [aria-label]')?.getAttribute('aria-label')).toBe(label);
    if (status === 'running') expect(host?.querySelector('[data-worker-outcome]')).toBeNull();
  }
});

it.each(['codex', 'claude-code'])('shows an honest cache estimate beside the %s worker composer', async runtime => {
  transcriptMock.slice.messages = [];
  await act(async () => root!.render(createElement(AgentTilePane, {
    sessionKey: `${runtime}-owned:cache-fixture`, agent: { name: 'Cache worker', status: 'idle', runtime },
    focused: true, onClose() {}, onFocus() {},
  })));
  expect(host!.querySelector('[data-session-cache]')?.textContent).toContain('Cache unknown · estimate');
});


it('collapses finished work to its written outcome, expands the transcript and hides without archiving', async () => {
  const fetcher = vi.fn(async () => Response.json({ agents: [] }));
  vi.stubGlobal('fetch', fetcher);
  const close = vi.fn();
  const review = vi.fn();
  const packet = { id: 'outcome', title: 'Repair split input', branchTarget: 'inline/123-repair-split-input',
    status: 'running', lane: { sessionKey: 'worker-outcome' },
    completionSummary: 'Preserved exact input through resize.\n[PR](https://example.test/pull/42) [Receipt](https://example.test/receipts/42)',
  } as OrchestratorPacket;
  const render = () => act(() => root!.render(createElement(AgentTilePane, {
    sessionKey: 'worker-outcome', agent: null, packet, focused: true, onClose: close, onFocus() {}, onOpenReview: review,
  })));
  render();
  expect(host!.querySelector('[data-worker-title]')?.textContent).toBe('Repair split input');
  expect(host!.querySelector('[data-worker-title]')?.getAttribute('title')).toBe(packet.branchTarget);
  expect(host!.querySelector('[data-worker-outcome-card]')).toBeNull();
  packet.status = 'awaiting_review';
  render();
  const card = host!.querySelector('[data-worker-outcome-card]')!;
  expect(card).not.toBeNull();
  expect(card.textContent).toContain('Needs review');
  expect(card.querySelector('[data-worker-outcome]')?.textContent).toBe('Preserved exact input through resize.');
  expect(card.querySelector('a[href="https://example.test/pull/42"]')?.getAttribute('aria-label')).toBe('Open PR');
  expect(card.querySelector('a[href="https://example.test/receipts/42"]')?.getAttribute('aria-label')).toBe('Open receipt');
  expect(host!.querySelector('[data-worker-transcript]')).toBeNull();
  const toggle = card.querySelector<HTMLButtonElement>('[aria-expanded]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  act(() => toggle.click());
  expect(host!.querySelector('[data-worker-transcript]')).not.toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  act(() => card.querySelector<HTMLButtonElement>('[data-worker-open-review]')!.click());
  expect(review).toHaveBeenCalledOnce();
  act(() => host!.querySelector<HTMLButtonElement>('[aria-label="Hide Repair split input pane"]')!.click());
  expect(close).toHaveBeenCalledExactlyOnceWith('worker-outcome');
  expect(fetcher.mock.calls.every(call => !((call as unknown[])[1] as RequestInit | undefined)?.method)).toBe(true);
  packet.status = 'running'; render();
  expect(host!.querySelector('[data-worker-outcome-card]')).toBeNull();
  expect(host!.querySelector('[data-worker-transcript]')).not.toBeNull();
  packet.status = 'awaiting_review'; render();
  expect(host!.querySelector('[data-worker-transcript]')).toBeNull();
  packet.status = 'failed'; packet.completionSummary = ''; render();
  expect(host!.querySelector('[data-worker-outcome-card]')?.textContent).toContain('Failed');
  expect(host!.querySelector('[data-worker-outcome]')).toBeNull();
  expect(host!.querySelector('[data-worker-transcript]')).toBeNull();
  packet.status = 'archived'; packet.completionSummary = '# Outcome\n\nKept commands intact.\n[Receipt](https://example.test/results)\nhttps://example.test/docs'; render();
  expect(host!.querySelector('[data-worker-outcome]')?.textContent).toBe('Kept commands intact.');
  expect(host!.querySelector('a[href="https://example.test/results"]')).not.toBeNull();
  expect(host!.querySelector('a[href="https://example.test/docs"]')).toBeNull();
});


it('keeps the last assistant outcome after tool output when no summary was saved', () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agents: [] })));
  packetTranscriptMock.entries = [
    { id: 'progress', role: 'assistant', text: 'Inspecting input.' },
    { id: 'tool', role: 'tool', text: 'Checks passed.', toolCalls: [{ name: 'shell', args: { command: 'verify' }, status: 'done' }] },
    { id: 'final', role: 'assistant', text: '  Kept input exact.  \nFull verification details.\n[PR](https://example.test/pull/42)',
      toolCalls: [{ name: 'shell', args: { command: 'verify' }, status: 'done' }] },
  ];
  const packet = { id: 'fallback', title: 'Preserve input', status: 'running' } as OrchestratorPacket;
  const render = () => act(() => root!.render(createElement(AgentTilePane, {
    sessionKey: 'fallback', agent: null, packet, focused: false, onClose() {}, onFocus() {},
  })));
  render();
  packet.status = 'awaiting_review'; render();
  expect(host!.querySelector('[data-worker-outcome]')?.textContent).toBe('Kept input exact.');
  expect(host!.querySelector('a[href="https://example.test/pull/42"]')).not.toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
  expect(host!.querySelector('[data-worker-transcript]')?.textContent).toContain('Full verification details.');
  expect(packetTranscriptMock.entries).toHaveLength(3);
});

it('keeps one review action and state without a composer or cache helper when a finished card expands', () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agents: [] })));
  const review = vi.fn();
  packetTranscriptMock.entries = [{ id: 'final', role: 'assistant', text: 'Kept input exact.' }];
  act(() => root!.render(createElement(AgentTilePane, {
    sessionKey: 'expanded-outcome', agent: null,
    packet: { id: 'expanded', title: 'Preserve input', status: 'awaiting_review', completionSummary: 'Kept input exact.' } as OrchestratorPacket,
    focused: false, onClose() {}, onFocus() {}, onOpenReview: review,
  })));
  act(() => host!.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
  expect(host!.querySelector('[data-worker-transcript]')?.textContent).toContain('Kept input exact.');
  expect(host!.querySelector('form')).toBeNull();
  expect(host!.querySelector('[data-session-cache]')).toBeNull();
  expect(host!.querySelector('[data-worker-state-row]')).toBeNull();
  expect(host!.textContent?.match(/Needs review/g)).toHaveLength(1);
  expect(host!.querySelectorAll('[data-worker-open-review]')).toHaveLength(1);
  act(() => host!.querySelector<HTMLButtonElement>('[data-worker-open-review]')!.click());
  expect(review).toHaveBeenCalledOnce();
});
