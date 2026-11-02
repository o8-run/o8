import { afterEach, describe, expect, it, vi } from 'vitest';

import { runStatus } from './status';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.O8_API_PORT;
});

describe('o8 status', () => {
  it('lists the enter-queues and title-model defaults with their source', async () => {
    process.env.O8_API_PORT = '47120';
    vi.stubGlobal('fetch', vi.fn(async (input: Request | URL) => {
      const url = String(input);
      if (url.includes('/api/lanes')) return Response.json({ lanes: [] });
      if (url.includes('/api/panel/approvals')) return Response.json({ approvals: [] });
      if (url.includes('/api/panel/operator-defaults')) {
        return Response.json({
          values: { composerEnterQueues: true, textGenerationTitleModel: '' },
          sources: { composerEnterQueues: 'file', textGenerationTitleModel: 'default' },
        });
      }
      return Response.json({});
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: false, verbose: false })).resolves.toBe(0);
    expect((JSON.parse(writes.join('')) as { operatorDefaults: unknown }).operatorDefaults).toEqual([
      { key: 'composerEnterQueues', setting: 'chat.enter_queues', value: true, source: 'file' },
      { key: 'textGenerationTitleModel', setting: 'text_generation.title_model', value: '', source: 'default' },
    ]);
  });

  it('keeps review and input-blocked lanes out of the running group', async () => {
    process.env.O8_API_PORT = '47120';
    const lanes = ['running', 'reviewing', 'awaiting_input'].map((status) => ({
      id: `lane-${status}`,
      label: `${status} work`,
      status,
      runtime: 'codex',
      branch: `work/${status}`,
      baseBranch: 'main',
      repoPath: '/tmp/status-fixture',
      worktreePath: null,
      packetId: `packet-${status}`,
      updatedAt: '2026-09-24T12:00:00.000Z',
      lastEventAt: '2026-09-24T12:00:00.000Z',
      lastEventLabel: status,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: Request | URL) => {
      const url = String(input);
      if (url.includes('/api/lanes')) return Response.json({ lanes });
      if (url.includes('/api/panel/approvals')) return Response.json({ approvals: [] });
      if (url.includes('/api/orchestrator/status')) return Response.json({ ok: true, result: { packets: [] } });
      return Response.json({});
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: false, verbose: false })).resolves.toBe(0);
    const payload = JSON.parse(writes.join('')) as {
      counts: { runningPackets: number; awaitingReview: number; activeLanes: number };
      runningPackets: Array<{ id: string; status: string }>;
      awaitingReview: Array<{ id: string; status: string }>;
      activeLanes: Array<{ id: string; status: string }>;
    };
    expect(payload.counts).toMatchObject({ runningPackets: 1, awaitingReview: 1, activeLanes: 3 });
    expect(payload.runningPackets.map((lane) => lane.id)).toEqual(['lane-running']);
    expect(payload.awaitingReview.map((lane) => lane.id)).toEqual(['lane-reviewing']);
    expect(payload.activeLanes).toContainEqual(expect.objectContaining({
      id: 'lane-awaiting_input', status: 'awaiting_input',
    }));

    writes.length = 0;
    await expect(runStatus({ human: true, verbose: false })).resolves.toBe(0);
    const output = writes.join('');
    expect(output).toMatch(/running 1\s+review 1\s+active 3/);
    expect(output).toMatch(/running[\s\S]*running work[\s\S]*awaiting review/);
    expect(output).not.toMatch(/running work[\s\S]*reviewing work[\s\S]*awaiting review/);
  });

  it('includes a packet storage hold and its operator-visible reason', async () => {
    process.env.O8_API_PORT = '47120';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/panel/approvals')) {
        return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
      }
      if (url.includes('/api/orchestrator/status')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            packets: [{
              id: 'packet-held',
              title: 'held packet',
              status: 'queued',
              blockedReason: 'Dispatch held by storage admission (reserve_breached).',
              storageAdmission: {
                state: 'held',
                reason: 'reserve_breached',
                recordedAt: 1_000,
                estimateBytes: 8_589_934_592,
                physicalAvailableBytes: 12_884_901_888,
                requiredReserveBytes: 10_737_418_240,
              },
            }],
          },
        }), { status: 200 });
      }
      if (url.includes('/api/panel/status')) {
        return new Response(JSON.stringify({
          shippedDarkAudit: {
            status: 'attention',
            checkedAt: '2026-08-27T12:05:00.000Z',
            currentRelease: '0.1.716',
            thresholdReleases: 3,
            checkedFlagCount: 14,
            attentionFlagCount: 1,
            flags: [{
              tomlKey: 'experimental.canvas_enabled',
              landedRelease: '0.1.681',
              darkForReleases: 35,
              lifecycle: 'promotion-candidate',
              lifecycleRationale: null,
              needsAttention: true,
            }, {
              tomlKey: 'review.quiz_gate_enabled',
              landedRelease: '0.1.681',
              darkForReleases: 35,
              lifecycle: 'deliberate-default-off',
              lifecycleRationale: 'Optional human quiz speed bump before the merge button.',
              needsAttention: false,
            }],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ lanes: [] }), { status: 200 });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: false, verbose: false })).resolves.toBe(0);
    const payload = JSON.parse(writes.join('')) as {
      counts: { shippedDarkWarnings: number; storageHolds: number };
      shippedDarkWarnings: Array<{ tomlKey: string; darkForReleases: number }>;
      shippedDarkByDesign: Array<{ tomlKey: string; lifecycle: string }>;
      storageHolds: Array<{ packetId: string; reason: string }>;
    };
    expect(payload.counts.storageHolds).toBe(1);
    expect(payload.storageHolds).toEqual([expect.objectContaining({
      packetId: 'packet-held',
      reason: expect.stringContaining('reserve_breached'),
    })]);
    // Same age for both flags: only the unreviewed promotion candidate warns,
    // and the deliberate one stays visible under its own key.
    expect(payload.counts.shippedDarkWarnings).toBe(1);
    expect(payload.shippedDarkWarnings).toEqual([expect.objectContaining({
      tomlKey: 'experimental.canvas_enabled',
      landedRelease: '0.1.681',
      darkForReleases: 35,
      lifecycle: 'promotion-candidate',
    })]);
    expect(payload.shippedDarkByDesign).toEqual([expect.objectContaining({
      tomlKey: 'review.quiz_gate_enabled',
      lifecycle: 'deliberate-default-off',
    })]);
  });

  it('prints a human warning only after the dark-release threshold', async () => {
    process.env.O8_API_PORT = '47120';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/panel/approvals')) {
        return Response.json({ approvals: [] });
      }
      if (url.includes('/api/orchestrator/status')) {
        return Response.json({ ok: true, result: { packets: [] } });
      }
      if (url.includes('/api/panel/status')) {
        return Response.json({
          shippedDarkAudit: {
            status: 'attention',
            checkedAt: '2026-08-27T12:05:00.000Z',
            currentRelease: '0.1.716',
            thresholdReleases: 3,
            checkedFlagCount: 14,
            attentionFlagCount: 1,
            flags: [{
              tomlKey: 'experimental.canvas_enabled',
              landedRelease: '0.1.681',
              darkForReleases: 35,
              lifecycle: 'promotion-candidate',
              lifecycleRationale: null,
              needsAttention: true,
            }, {
              tomlKey: 'experimental.chat_enabled',
              landedRelease: '0.1.681',
              darkForReleases: 35,
              lifecycle: 'deliberate-default-off',
              lifecycleRationale: 'Alpha-only casual chat tab.',
              needsAttention: false,
            }, {
              tomlKey: 'broadcast.voice',
              landedRelease: '0.1.715',
              darkForReleases: 1,
              lifecycle: 'promotion-candidate',
              lifecycleRationale: null,
              needsAttention: false,
            }, {
              tomlKey: 'experimental.release_unknown',
              landedRelease: null,
              darkForReleases: null,
              lifecycle: 'promotion-candidate',
              lifecycleRationale: null,
              needsAttention: false,
            }],
          },
        });
      }
      return Response.json({ lanes: [] });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: true, verbose: false })).resolves.toBe(0);
    const output = writes.join('');
    expect(output).toContain('shipped but dark');
    expect(output).toContain('experimental.canvas_enabled');
    expect(output).toContain('awaiting promotion review');
    expect(output).toContain('35 releases');
    // Deliberate and under-threshold flags stay legible without a warning.
    expect(output).toContain('experimental.chat_enabled');
    expect(output).toContain('by design: Alpha-only casual chat tab.');
    expect(output).toContain('broadcast.voice');
    expect(output).toContain('experimental.release_unknown');
    expect(output).toContain('release age unknown');
    expect(output).not.toContain('null releases');
    expect(output).toMatch(/dark flags 1/);
  });

  it('trusts the server verdict and only recomputes it for pre-v2 payloads', async () => {
    process.env.O8_API_PORT = '47120';
    const flags = [{
      // Old enough to trip the local threshold, but the server already decided
      // this flag is not overdue — the CLI must not second-guess it.
      tomlKey: 'experimental.chat_enabled',
      landedRelease: '0.1.681',
      darkForReleases: 35,
      lifecycle: 'promotion-candidate',
      lifecycleRationale: null,
      needsAttention: false,
    }, {
      // Pre-v2 payload shape: no lifecycle, no verdict. Recomputation applies.
      tomlKey: 'review.quiz_gate_enabled',
      landedRelease: '0.1.681',
      darkForReleases: 35,
    }];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/panel/approvals')) return Response.json({ approvals: [] });
      if (url.includes('/api/orchestrator/status')) return Response.json({ ok: true, result: { packets: [] } });
      if (url.includes('/api/panel/status')) {
        return Response.json({
          shippedDarkAudit: {
            status: 'attention',
            checkedAt: '2026-08-27T12:05:00.000Z',
            currentRelease: '0.1.716',
            thresholdReleases: 3,
            checkedFlagCount: 14,
            attentionFlagCount: 1,
            flags,
          },
        });
      }
      return Response.json({ lanes: [] });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: false, verbose: false })).resolves.toBe(0);
    const payload = JSON.parse(writes.join('')) as {
      counts: { shippedDarkWarnings: number };
      shippedDarkWarnings: Array<{ tomlKey: string }>;
    };
    expect(payload.counts.shippedDarkWarnings).toBe(1);
    expect(payload.shippedDarkWarnings.map((flag) => flag.tomlKey))
      .toEqual(['review.quiz_gate_enabled']);
  });
});
