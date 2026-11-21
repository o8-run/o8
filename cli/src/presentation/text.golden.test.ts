import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Run the real packet info command with its network and config stubbed.
const fixtureUrl = new URL('./fixtures/packet.fixture.json', import.meta.url);
const goldenUrl = (variant: 'plain' | 'tty') =>
  new URL(`./fixtures/packet-info.${variant}.txt`, import.meta.url);
const { packet } = JSON.parse(readFileSync(fixtureUrl, 'utf8'));

vi.mock('../config.js', () => ({ resolveConfig: () => ({ apiBase: 'http://127.0.0.1:1' }) }));
vi.mock('../commands/packet/target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/packet/target.js')>()),
  resolvePacketTarget: async () => ({
    lane: {
      id: packet.laneId, packetId: packet.id, label: packet.label, status: packet.status,
      runtime: packet.runtime, branch: packet.branch, baseBranch: packet.baseBranch,
      repoPath: packet.repoPath, worktreePath: packet.worktreePath,
    },
  }),
}));
vi.mock('../api.js', () => ({
  apiFetch: async (_cfg: unknown, path: string) => path.endsWith('/scope')
    ? { data: { actualRuntime: packet.actualRuntime } }
    : { data: { events: packet.events } },
}));

const { runPacketInfo } = await import('../commands/packet/info.js');

async function run(isTTY: boolean): Promise<string> {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  let text = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  });
  try {
    expect(await runPacketInfo({ human: true, verbose: false }, [packet.id])).toBe(0);
  } finally {
    write.mockRestore();
  }
  return text;
}

describe('o8 packet info human output golden', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  afterEach(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  for (const [variant, isTTY] of [['plain', false], ['tty', true]] as const) {
    it(`matches the ${variant} golden byte for byte`, async () => {
      const text = await run(isTTY);
      if (process.env.O8_UPDATE_GOLDEN === '1') writeFileSync(goldenUrl(variant), text);
      expect(text).toBe(readFileSync(goldenUrl(variant), 'utf8'));
    });
  }
});
