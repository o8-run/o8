import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { execFileSync } from '@/lib/providers/child-process';

// Explicit opt-in only: real synthesis, without starting a server or playing audio.
const fixture = vi.hoisted(() => ({ native: vi.fn(async () => { throw new Error('Unexpected server response: 403'); }) }));
vi.mock('@/lib/tts/edge-neural', () => ({ synthesizeEdgeNeural: fixture.native }));

it.skipIf(process.env.O8_TEST_INSTALLED_EDGE_TTS !== '1')('serves installed edge-tts 7.3.1 through POST after native drift', async () => {
  const python = process.env.O8_TTS_PYTHON || 'python3';
  const version = execFileSync(python, ['-c', "import importlib.metadata as m; print(m.version('edge-tts'))"], { encoding: 'utf8', timeout: 10_000 }).trim();
  // Fail before importing the route if preparation could alter the installation.
  expect(version).toBe('7.3.1');
  const { POST } = await import('@/app/api/tts/route');
  for (let i = 0; i < 2; i++) {
    const response = await POST(new NextRequest('http://localhost/api/tts', {
      method: 'POST', body: JSON.stringify({ text: 'Steffan voice check. The free voice is ready.' }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    const audio = new Uint8Array(await response.arrayBuffer());
    expect(audio.byteLength).toBeGreaterThan(1_000);
    expect(response.headers.get('Content-Length')).toBe(String(audio.byteLength));
    process.stdout.write(`[installed-edge-tts] version=${version} request=${i + 1} status=${response.status} audio=${audio.byteLength} bytes\n`);
  }
  expect(fixture.native).toHaveBeenCalledTimes(1);
});
