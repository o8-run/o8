export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { MODEL_IDS } from '@/lib/models';
import { resolveProviderKey } from '@/lib/providers/key-store';
import {
  buildPolishSystemPrompt,
  straightenQuotes,
  type DictationPolishContext,
  type DictationSurface,
} from '@/lib/dictation/polish-prompt';
import { processVoiceCommands } from '@/lib/dictation/voice-commands';

// Polish runs on Claude Haiku only, with the operator's Anthropic key, as the
// desktop voice app polishes. No key, an error or a timeout returns the
// pre-cleaned transcript unpolished.
const POLISH_MODEL = MODEL_IDS.raw.anthropicClaudeHaiku55;
// A person is waiting to send. A few minutes of speech is around 1,000 output
// tokens, which Haiku, the fastest Claude tier, writes well inside this; past
// it, the raw text goes out instead of holding the send any longer.
const POLISH_TIMEOUT_MS = 15_000;

interface PolishRequestBody {
  transcript?: string;
  surface?: DictationSurface;
  context?: DictationPolishContext;
}

/**
 * POST /api/dictation/polish
 *
 * Cleans up a raw transcript with one Claude Haiku call using the
 * dev-aware adaptive-punctuation prompt from polish-prompt.ts.
 * Voice commands ("cancel", "scratch that", "remove that", "new line")
 * are processed deterministically before polish — saves an LLM call on
 * the most common cancellation phrases.
 *
 * Returns `{ text }` (polished text or empty if cancelled by voice).
 */
export async function POST(request: Request) {
  let body: PolishRequestBody;
  try {
    body = await request.json() as PolishRequestBody;
  } catch {
    return NextResponse.json({ error: 'Expected JSON body.' }, { status: 400 });
  }

  const transcript = (body.transcript ?? '').trim();
  if (!transcript) {
    return NextResponse.json({ text: '' });
  }

  // Deterministic pre-pass: catch cancellations + insert literal newlines.
  const command = processVoiceCommands(transcript);
  if (command.kind === 'cancel') {
    return NextResponse.json({ text: '', cancelled: true, reason: command.reason });
  }
  const preCleaned = command.text;

  const surface: DictationSurface = body.surface ?? 'general';
  const systemPrompt = buildPolishSystemPrompt(surface, body.context ?? {});

  const apiKey = resolveProviderKey('ANTHROPIC_API_KEY');
  if (!apiKey) {
    // Polish is best-effort: without a key the pre-cleaned transcript still
    // goes out, just unpolished.
    return NextResponse.json({ text: preCleaned, polished: false });
  }

  let failure: string;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: POLISH_MODEL,
        // Room for a long dictation; a cap below it truncates silently.
        max_tokens: 16_384,
        system: systemPrompt,
        messages: [{ role: 'user', content: `RAW TRANSCRIPT:\n${preCleaned}` }],
      }),
      signal: AbortSignal.timeout(POLISH_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(text) as { content?: Array<{ type?: string; text?: string }> };
      // Typographic quotes break text dictated into a terminal or code.
      const polished = straightenQuotes(
        parsed.content?.find((block) => block.type === 'text')?.text?.trim() ?? '',
      );
      if (polished) return NextResponse.json({ text: polished, polished: true });
      failure = 'Claude returned no text.';
    } else {
      failure = `Claude HTTP ${response.status} ${text.slice(0, 160)}`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : 'unknown error';
  }

  // Fall back to the pre-cleaned transcript so the user still gets text;
  // the detail lets the client warn.
  return NextResponse.json({ text: preCleaned, polished: false, error: `Polish failed. ${failure}` });
}
