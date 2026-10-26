/**
 * POST /api/tts — Server-side Edge neural TTS (Steffan et al).
 *
 * Browser can't set custom headers on WebSocket (Sec-MS-GEC etc.), so the
 * server synthesizes and streams the MP3 back. Primary tier is the NATIVE
 * Node client (lib/tts/edge-neural.ts — zero machine deps); the Python
 * edge-tts CLI remains as a fallback tier only (it requires a pip install
 * that fresh machines don't have — report S9KT8H).
 *
 * Body: { text: string, voice?: string }
 * Returns: audio/mpeg stream
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from '@/lib/providers/child-process';
import { synthesizeEdgeNeural } from '@/lib/tts/edge-neural';
import { ensureEdgeTtsInstalled, getEdgeTtsStatus } from '@/lib/tts/ensure-edge-tts';
import type { EdgeVoiceError } from '@/lib/tts/edge-voice-error';

// A rejected token scheme will not recover by retrying the same native client.
const runtime = globalThis as typeof globalThis & { __o8EdgeTtsNativeDrift?: boolean };

function isForbidden(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const err = error as { status?: number; statusCode?: number; response?: { statusCode?: number } };
    if (err.status === 403 || err.statusCode === 403 || err.response?.statusCode === 403) return true;
  }
  return /\b403\b/.test(String(error));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text: string = body.text ?? '';
    const voice: string = body.voice ?? 'en-US-SteffanNeural';

    if (!text.trim()) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 });
    }

    // Limit text length to prevent abuse
    const trimmedText = text.slice(0, 10_000);

    // Never wait for pip on the request path. Startup normally prepares this;
    // this also covers servers that receive TTS before optional boot finishes.
    void ensureEdgeTtsInstalled();

    let mp3: Buffer | undefined;
    if (!runtime.__o8EdgeTtsNativeDrift) {
      try {
        mp3 = await synthesizeEdgeNeural(trimmedText, voice);
      } catch (nativeError) {
        if (isForbidden(nativeError)) {
          runtime.__o8EdgeTtsNativeDrift = true;
          void ensureEdgeTtsInstalled('forbidden');
        }
        console.warn('[TTS API] native voice failed; trying Python CLI:', nativeError);
      }
    }
    if (!mp3) {
      try {
        mp3 = await runEdgeTTS(trimmedText, voice);
      } catch (pythonError) {
        if (isForbidden(pythonError)) void ensureEdgeTtsInstalled('forbidden');
        const code: EdgeVoiceError = getEdgeTtsStatus() === 'update_required' || isForbidden(pythonError)
          ? 'edge_voice_update_required' : 'edge_voice_unavailable';
        console.warn('[TTS API]', code, pythonError);
        return NextResponse.json({ error: 'Steffan voice unavailable', code }, { status: 503 });
      }
    }

    return new NextResponse(new Uint8Array(mp3), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': mp3.byteLength.toString(),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[TTS API] Error:', err);
    return NextResponse.json(
      { error: 'TTS generation failed', details: String(err) },
      { status: 500 },
    );
  }
}

function runEdgeTTS(text: string, voice: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Use edge-tts CLI: writes to stdout with --write-media -
    const proc = spawn(process.env.O8_TTS_PYTHON || 'python3', [
      '-m', 'edge_tts',
      '--voice', voice,
      '--text', text,
      '--write-media', '-',
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`edge-tts exited ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn edge-tts: ${err.message}`));
    });
  });
}
