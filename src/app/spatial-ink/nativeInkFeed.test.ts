import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { INK_TIMING, type InkReply } from '@/lib/next/spatial-ink';
import { NativeInkFeed, type NativeInkDeps, type NormalizedStroke } from './nativeInkFeed';

const MONITOR = { x: -1920, y: 102, width: 1920, height: 1080 };
type Reply = InkReply | Error | 'hang';

function harness(replies: Reply[], webInk = false) {
  const requests: Record<string, unknown>[] = [];
  const pointer: Array<[string, number]> = [];
  const adopted: NormalizedStroke[][] = [];
  let firstStrokes = 0;
  const deps: NativeInkDeps = {
    request: (body) => {
      requests.push(body);
      const reply = replies.shift() ?? { native: true };
      if (reply === 'hang') return new Promise((_, reject) => setTimeout(() => reject(new Error('Ink deadline')), INK_TIMING.requestMs));
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    pointer: (owner, generation) => { pointer.push([owner, generation]); },
    firstStroke: () => { firstStrokes++; },
    adopt: (strokes) => { adopted.push(strokes); },
    webHasInk: () => webInk,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  return { feed: new NativeInkFeed(deps), requests, pointer, adopted, firstStrokes: () => firstStrokes };
}
const cadence = () => vi.advanceTimersByTimeAsync(INK_TIMING.cadenceMs);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('arms, hands the pointer over, relays points in order and returns them all at final', async () => {
  const h = harness([
    { native: true, capturing: true, next: 0 },
    { native: true, capturing: true, points: [[0, 0.1, 0.2, 0], [0, 0.2, 0.3, 16]], next: 2 },
    { native: true, capturing: true, points: [[1, 0.5, 0.5, 0]], next: 3 },
    { native: true, capturing: false, disarmed: 'handoff', points: [[1, 0.6, 0.6, 20]], next: 4 },
  ]);
  await h.feed.begin({ generation: 9, monitor: MONITOR, reducedMotion: false });
  expect(h.requests[0]).toEqual({ action: 'arm', session: 1, monitor: MONITOR, reducedMotion: false });
  expect(h.pointer).toEqual([['native', 9]]);
  expect(h.feed.nativeOwned).toBe(true);
  await cadence();
  expect(h.requests[1]).toEqual({ action: 'frame', session: 1, from: 0 });
  expect(h.firstStrokes()).toBe(1);
  await cadence();
  expect(h.requests[2]).toEqual({ action: 'frame', session: 1, from: 2 });
  expect(h.firstStrokes()).toBe(1);
  const strokes = await h.feed.finish();
  expect(h.requests[3]).toEqual({ action: 'release', session: 1, handoff: true, from: 3 });
  expect(strokes).toEqual([
    [{ x: 0.1, y: 0.2, t: 0 }, { x: 0.2, y: 0.3, t: 16 }],
    [{ x: 0.5, y: 0.5, t: 0 }, { x: 0.6, y: 0.6, t: 20 }],
  ]);
  // Capture is over: no keep-alive follows, and a terminal event sends nothing more.
  await cadence(); await cadence();
  h.feed.release();
  expect(h.requests).toHaveLength(4);
  expect(h.adopted).toEqual([]);
});

it('stays on the web when the flag is off or no native window answers', async () => {
  for (const reply of [{ native: false }, new Error('Ink deadline')] as Reply[]) {
    const h = harness([reply]);
    await h.feed.begin({ generation: 1, monitor: MONITOR, reducedMotion: false });
    expect(h.feed.owner).toBe('web');
    expect(h.pointer).toEqual([]);
    await cadence(); await cadence();
    expect(h.requests).toHaveLength(1);
    expect(await h.feed.finish()).toBeNull();
  }
});

it('takes the hold back with every point when a keep-alive misses its deadline', async () => {
  const h = harness([
    { native: true, capturing: true },
    { native: true, capturing: true, points: [[0, 0.1, 0.1, 0], [0, 0.2, 0.2, 10]], next: 2 },
    'hang',
  ]);
  await h.feed.begin({ generation: 4, monitor: MONITOR, reducedMotion: false });
  await cadence();
  await cadence();
  expect(h.pointer).toEqual([['native', 4]]);
  await vi.advanceTimersByTimeAsync(INK_TIMING.requestMs);
  // Web reclaims before the native lease (measured from the last frame) ends.
  expect(INK_TIMING.cadenceMs + INK_TIMING.requestMs).toBeLessThan(INK_TIMING.leaseMs);
  expect(h.pointer).toEqual([['native', 4], ['web', 4]]);
  expect(h.adopted).toEqual([[[{ x: 0.1, y: 0.1, t: 0 }, { x: 0.2, y: 0.2, t: 10 }]]]);
  expect(h.feed.owner).toBe('web');
  expect(h.requests.at(-1)).toEqual({ action: 'release', session: 1, immediate: true });
  // The web path finishes the hold.
  expect(await h.feed.finish()).toBeNull();
});

it('takes the hold back when the native panel lost its lease or refused a frame', async () => {
  const h = harness([
    { native: true, capturing: true },
    { native: false, capturing: false, disarmed: 'lease', points: [[0, 0.3, 0.3, 0]], next: 1 },
  ]);
  await h.feed.begin({ generation: 2, monitor: MONITOR, reducedMotion: false });
  await cadence();
  expect(h.pointer).toEqual([['native', 2], ['web', 2]]);
  expect(h.adopted).toEqual([[[{ x: 0.3, y: 0.3, t: 0 }]]]);
});

it('Escape on the panel keeps it drawing without capture; the time bound leaves nobody capturing', async () => {
  const h = harness([
    { native: true, capturing: true },
    { native: true, capturing: false, disarmed: 'escape', points: [[0, 0.4, 0.4, 0]], next: 1 },
    { native: true, capturing: false, disarmed: 'escape' },
    { native: false, capturing: false, disarmed: 'bound' },
    { native: false, disarmed: 'bound' },
  ]);
  await h.feed.begin({ generation: 3, monitor: MONITOR, reducedMotion: false });
  await cadence(); await cadence();
  expect(h.feed.owner).toBe('native');
  expect(h.pointer).toEqual([['native', 3]]);
  await cadence();
  // The bound: no reclaim, no more keep-alives, the points still go out at final.
  expect(h.feed.owner).toBe('held');
  expect(h.pointer).toEqual([['native', 3]]);
  const sent = h.requests.length;
  await cadence(); await cadence();
  expect(h.requests).toHaveLength(sent);
  expect(await h.feed.finish()).toEqual([[{ x: 0.4, y: 0.4, t: 0 }]]);
});

it('keeps the web owner when the operator drew before the panel answered', async () => {
  const h = harness([
    { native: true, capturing: true },
    { native: true, points: [[0, 0.7, 0.7, 0]], next: 1 },
  ], true);
  await h.feed.begin({ generation: 5, monitor: MONITOR, reducedMotion: false });
  expect(h.feed.owner).toBe('web');
  expect(h.pointer).toEqual([]);
  expect(h.requests[1]).toEqual({ action: 'release', session: 1, immediate: true, from: 0 });
  expect(h.adopted).toEqual([[[{ x: 0.7, y: 0.7, t: 0 }]]]);
});

it('a terminal event during the arm releases the panel and never hands it the pointer', async () => {
  let answer: (reply: InkReply) => void = () => {};
  const requests: Record<string, unknown>[] = [];
  const pointer = vi.fn();
  const feed = new NativeInkFeed({
    request: (body) => { requests.push(body); return body.action === 'arm' ? new Promise(resolve => { answer = resolve; }) : Promise.resolve({ native: true }); },
    pointer, firstStroke: () => {}, adopt: () => {}, webHasInk: () => false,
    setTimer: (run, ms) => setTimeout(run, ms), clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  const begun = feed.begin({ generation: 6, monitor: MONITOR, reducedMotion: false });
  feed.release();
  answer({ native: true, capturing: true });
  await begun;
  expect(pointer).not.toHaveBeenCalled();
  expect(requests.filter(body => body.action === 'release')).toHaveLength(2);
  expect(feed.owner).toBe('web');
});
