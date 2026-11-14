import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMission } from './mission';
import { EXIT } from '../api';

const mode = { human: false, verbose: false };

function missionResponse() {
  return {
    ok: true,
    result: {
      missionId: 'mission-effort-pin',
      packets: [{ id: 'pkt-effort-pin', title: 'effort pin', wave: 1 }],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.O8_API_PORT;
});

describe('o8 mission create --effort', () => {
  it('carries a valid --effort pin into the create-mission request body', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(missionResponse()), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runMission(mode, 'create', [
      '--title', 'effort pin',
      '--repo', process.cwd(),
      '--runtime', 'codex',
      '--model', 'gpt-5.6-terra',
      '--effort', 'high',
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/orchestrator/create-mission');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.requestedEffort).toBe('high');
  });

  it('omits requestedEffort entirely when --effort is not passed (parity)', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(missionResponse()), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runMission(mode, 'create', [
      '--title', 'no effort pin',
      '--repo', process.cwd(),
      '--runtime', 'codex',
    ])).resolves.toBe(0);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('requestedEffort');
  });

  it('rejects a malformed --effort before any request is sent', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMission(mode, 'create', [
      '--title', 'bad effort pin',
      '--repo', process.cwd(),
      '--effort', 'turbo',
    ])).rejects.toMatchObject({ code: 'invalid_args', exit: EXIT.INVALID_ARGS });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a valueless --effort before any request is sent', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMission(mode, 'create', [
      '--title', 'valueless effort pin',
      '--repo', process.cwd(),
      '--effort',
    ])).rejects.toMatchObject({ code: 'invalid_args', exit: EXIT.INVALID_ARGS });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects conflicting repeated --effort instead of first-flag-wins', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMission(mode, 'create', [
      '--title', 'repeated effort pin',
      '--repo', process.cwd(),
      '--effort', 'high',
      '--effort', 'low',
    ])).rejects.toMatchObject({ code: 'invalid_args', exit: EXIT.INVALID_ARGS });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('o8 mission terminal status reports (#6137)', () => {
  const human = { human: true, verbose: false };
  const OSC = '\x1b]7501;';
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  afterEach(() => {
    delete process.env.REX_SESSION;
    delete process.env.O8_TERMINAL_STATUS;
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  function statusResponse(status: string, title = 'Fix login redirect') {
    return {
      ok: true,
      result: {
        missionId: 'mission-tab',
        packets: [{ id: 'pkt-tab', title, status, blockedReason: '/private/path/secret.ts failed' }],
      },
    };
  }

  /** Runs one mission subcommand against scripted status responses and returns stdout. */
  async function run(
    opts: { tty: boolean; mode: typeof mode; statuses: string[]; title?: string },
    secondary: 'wait' | 'dispatch',
    rest: string[],
  ): Promise<string> {
    process.env.O8_API_PORT = '47120';
    Object.defineProperty(process.stdout, 'isTTY', { value: opts.tty, configurable: true });
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/orchestrator/dispatch')) {
        return new Response(JSON.stringify({ ok: true, result: { initiated: true, missionId: 'mission-tab', dispatched: 1 } }), { status: 200 });
      }
      const status = opts.statuses[Math.min(call, opts.statuses.length - 1)];
      call += 1;
      return new Response(JSON.stringify(statusResponse(status, opts.title)), { status: 200 });
    }));
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    await expect(runMission(opts.mode, secondary, rest)).resolves.toBe(0);
    return out;
  }

  function reports(out: string): Array<Record<string, string>> {
    return out.split(OSC).slice(1).map((part) => {
      const body = part.slice(0, part.indexOf('\x1b\\'));
      return Object.fromEntries(body.split(':').map((pair) => {
        const at = pair.indexOf('=');
        const key = pair.slice(0, at);
        const value = pair.slice(at + 1);
        return [key, key === 'title' || key === 'msg' ? Buffer.from(value, 'base64').toString('utf8') : value];
      }));
    });
  }

  const waitArgs = ['--mission', 'mission-tab', '--timeout', '5s', '--poll', '1000'];

  it('mission wait: shows working, then keeps done for a packet that reaches review', async () => {
    process.env.REX_SESSION = 'session:test';
    const out = await run({ tty: true, mode: human, statuses: ['running', 'awaiting_review'] }, 'wait', waitArgs);
    expect(reports(out)).toEqual([
      { state: 'working', id: 'o8', app: 'o8', title: 'Fix login redirect', msg: 'Waiting for review' },
      { state: 'done', id: 'o8', app: 'o8', title: 'Fix login redirect', msg: 'Awaiting review' },
    ]);
    // The final record is the last thing written, so it survives the exit.
    expect(out.endsWith('\x1b\\')).toBe(true);
  });

  it('mission wait: reports error for a failed packet without leaking the blocked reason', async () => {
    process.env.REX_SESSION = 'session:test';
    const out = await run({ tty: true, mode: human, statuses: ['failed'] }, 'wait', waitArgs);
    expect(reports(out)).toEqual([{ state: 'error', id: 'o8', app: 'o8', title: 'Fix login redirect', msg: 'Failed' }]);
    const decoded = reports(out).map((r) => `${r.title} ${r.msg}`).join(' ');
    expect(decoded).not.toContain('secret.ts');
  });

  it('mission wait: clears the record when the watcher times out', async () => {
    process.env.REX_SESSION = 'session:test';
    const out = await run({ tty: true, mode: human, statuses: ['running'] }, 'wait', ['--mission', 'mission-tab', '--timeout', '1s', '--poll', '1000']);
    expect(reports(out).map((r) => r.state)).toEqual(['working', 'clear']);
  });

  it('mission dispatch --watch: shows working, then error for a blocked packet', async () => {
    process.env.REX_SESSION = 'session:test';
    const out = await run(
      { tty: true, mode: human, statuses: ['running', 'blocked'] },
      'dispatch',
      ['--mission', 'mission-tab', '--watch', '--timeout', '5s', '--poll', '1000'],
    );
    expect(reports(out)).toEqual([
      { state: 'working', id: 'o8', app: 'o8', title: 'Fix login redirect', msg: 'Waiting for review' },
      { state: 'error', id: 'o8', app: 'o8', title: 'Fix login redirect', msg: 'Blocked: needs a decision' },
    ]);
  });

  it('strips control characters from a packet title', async () => {
    process.env.REX_SESSION = 'session:test';
    const out = await run({ tty: true, mode: human, statuses: ['released'], title: 'bad\x1b[31m\ntitle' }, 'wait', waitArgs);
    expect(reports(out)).toEqual([{ state: 'done', id: 'o8', app: 'o8', title: 'bad [31m title', msg: 'Released' }]);
  });

  it.each([
    ['REX_SESSION unset', { tty: true, mode: human, rex: false }],
    ['JSON output', { tty: true, mode, rex: true }],
    ['piped stdout', { tty: false, mode: human, rex: true }],
  ])('output is byte-identical to the disabled output: %s', async (_name, c) => {
    for (const [secondary, rest] of [
      ['wait', waitArgs],
      ['dispatch', ['--mission', 'mission-tab', '--watch', '--timeout', '5s', '--poll', '1000']],
    ] as const) {
      if (c.rex) process.env.REX_SESSION = 'session:test';
      else delete process.env.REX_SESSION;
      delete process.env.O8_TERMINAL_STATUS;
      const out = await run({ tty: c.tty, mode: c.mode, statuses: ['awaiting_review'] }, secondary, [...rest]);
      vi.restoreAllMocks();
      process.env.O8_TERMINAL_STATUS = '0';
      const baseline = await run({ tty: c.tty, mode: c.mode, statuses: ['awaiting_review'] }, secondary, [...rest]);
      vi.restoreAllMocks();
      expect(out).not.toContain(OSC);
      expect(out).toBe(baseline);
    }
  });

  it('O8_TERMINAL_STATUS=0 disables reports in Rex and =1 forces them without Rex', async () => {
    process.env.REX_SESSION = 'session:test';
    process.env.O8_TERMINAL_STATUS = '0';
    expect(await run({ tty: true, mode: human, statuses: ['awaiting_review'] }, 'wait', waitArgs)).not.toContain(OSC);
    vi.restoreAllMocks();
    delete process.env.REX_SESSION;
    process.env.O8_TERMINAL_STATUS = '1';
    const forced = await run({ tty: true, mode: human, statuses: ['awaiting_review'] }, 'wait', waitArgs);
    expect(reports(forced).map((r) => r.state)).toEqual(['done']);
  });

  it('forced JSON output keeps stdout parseable and writes the report to stderr', async () => {
    process.env.O8_TERMINAL_STATUS = '1';
    const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    let err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
    try {
      const out = await run({ tty: true, mode, statuses: ['running', 'awaiting_review'] }, 'wait', waitArgs);
      expect(out).not.toContain(OSC);
      expect((JSON.parse(out) as { schema: string }).schema).toBe('o8/cli/mission.wait/v1');
      expect(reports(err).map((r) => r.state)).toEqual(['working', 'done']);
    } finally {
      if (stderrTty) Object.defineProperty(process.stderr, 'isTTY', stderrTty);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  });

  it('clears the working record when a status read fails mid-watch', async () => {
    process.env.REX_SESSION = 'session:test';
    process.env.O8_API_PORT = '47120';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call > 1) return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 });
      return new Response(JSON.stringify(statusResponse('running')), { status: 200 });
    }));
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    await expect(runMission(human, 'wait', waitArgs)).rejects.toBeDefined();
    expect(reports(out).map((r) => r.state)).toEqual(['working', 'clear']);
  });

  it('labels a mission with several packets by count and reports the one that finished', async () => {
    process.env.REX_SESSION = 'session:test';
    process.env.O8_API_PORT = '47120';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      const packets = [
        { id: 'pkt-a', title: 'First', status: 'running' },
        { id: 'pkt-b', title: 'Second', status: call > 1 ? 'released' : 'running' },
      ];
      return new Response(JSON.stringify({ ok: true, result: { missionId: 'mission-tab', packets } }), { status: 200 });
    }));
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    await expect(runMission(human, 'wait', waitArgs)).resolves.toBe(0);
    expect(reports(out).map((r) => [r.state, r.title])).toEqual([['working', '2 packets'], ['done', 'Second']]);
  });

  describe('mission tail', () => {
    const tailArgs = ['--mission', 'mission-tab', '--timeout', '5s', '--poll', '1000'];

    async function tail(
      opts: { tty: boolean; mode: typeof mode },
      script: Array<Array<{ id: string; title: string; status: string }>>,
      rest = tailArgs,
    ): Promise<string> {
      process.env.O8_API_PORT = '47120';
      Object.defineProperty(process.stdout, 'isTTY', { value: opts.tty, configurable: true });
      let call = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        const packets = script[Math.min(call, script.length - 1)];
        call += 1;
        return new Response(JSON.stringify({ ok: true, result: { missionId: 'mission-tab', packets } }), { status: 200 });
      }));
      let out = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        out += String(chunk);
        return true;
      });
      await expect(runMission(opts.mode, 'tail', rest)).resolves.toBe(0);
      return out;
    }

    const a = (status: string) => ({ id: 'pkt-a', title: 'First', status });
    const b = (status: string) => ({ id: 'pkt-b', title: 'Second', status });

    it('gives each packet its own record and keeps the outcome marks', async () => {
      process.env.REX_SESSION = 'session:test';
      const out = await tail({ tty: true, mode: human }, [
        [a('running'), b('queued')],
        [a('awaiting_review'), b('failed')],
      ]);
      expect(reports(out)).toEqual([
        { state: 'working', id: 'o8/pkt-a', app: 'o8', title: 'First', msg: 'Running' },
        { state: 'working', id: 'o8/pkt-b', app: 'o8', title: 'Second', msg: 'Queued' },
        { state: 'working', id: 'o8', app: 'o8', title: '2 packets', msg: '0 of 2 finished' },
        { state: 'done', id: 'o8/pkt-a', app: 'o8', title: 'First', msg: 'Awaiting review' },
        { state: 'error', id: 'o8/pkt-b', app: 'o8', title: 'Second', msg: 'Failed' },
        { state: 'error', id: 'o8', app: 'o8', title: '2 packets', msg: '1 of 2 failed, blocked, or archived' },
      ]);
    });

    it('clears every mark when the tail times out', async () => {
      process.env.REX_SESSION = 'session:test';
      const out = await tail({ tty: true, mode: human }, [[a('running')]], ['--mission', 'mission-tab', '--timeout', '1s', '--poll', '1000']);
      const all = reports(out);
      expect(all[all.length - 1]).toEqual({ state: 'clear', id: 'o8' });
    });

    it.each([
      ['JSON output', { tty: true, mode }, true],
      ['piped stdout', { tty: false, mode: human }, true],
      ['REX_SESSION unset', { tty: true, mode: human }, false],
    ])('writes no sequence: %s', async (_name, opts, rex) => {
      if (rex) process.env.REX_SESSION = 'session:test';
      const out = await tail(opts, [[a('released')]]);
      expect(out).not.toContain(OSC);
      expect(out).not.toContain('\x1b]');
    });
  });
});
