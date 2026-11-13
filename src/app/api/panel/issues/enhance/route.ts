import { readJsonObject } from '@/lib/panel/read-json-object';
import { resolveProviderKey } from '@/lib/providers/key-store';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { ensureGitHubIssues, fetchGitHubLabels, resolveRepoSlug } from '@/lib/github-broker';

const geminiKey = () => resolveProviderKey('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export async function POST(request: Request) {
  const GEMINI_API_KEY = geminiKey();
  const body = await readJsonObject(request);
    if (!body) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
  const { title, description, repo } = body as {
    title?: string;
    description?: string;
    repo?: string;
  };

  const rawInput = [title, description].filter(Boolean).join('\n\n');
  if (!rawInput.trim()) {
    return NextResponse.json({ error: 'Title or description required' }, { status: 400 });
  }

  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  // Fetch repo context in parallel
  const repoSlug = await resolveRepoSlug(repo || null, '');
  const [labels, recentTitles] = await Promise.all([
    repoSlug ? fetchGitHubLabels(repoSlug, 30).catch(() => []) : Promise.resolve([]),
    repoSlug
      ? ensureGitHubIssues(repoSlug)
          .then((result) => result.issues.slice(0, 8).map((issue) => issue.title))
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  const systemPrompt = `You are a GitHub issue writer for a software project. Your job is to take rough ideas and turn them into well-structured GitHub issues.

Available labels for this repo: ${labels.length > 0 ? labels.join(', ') : 'bug, enhancement, documentation'}

Recent issue titles for style reference:
${recentTitles.map(t => `- ${t}`).join('\n')}

Rules:
- Return a JSON object with these fields: { "title": "...", "body": "...", "labels": ["..."] }
- Title: concise, specific, action-oriented (imperative mood). Match the style of existing issues.
- Body: use markdown with these sections:
  ## Description
  Clear explanation of the issue or feature request.
  
  ## Steps to Reproduce (for bugs only, omit for features)
  Numbered steps if applicable.
  
  ## Expected Behavior
  What should happen.
  
  ## Acceptance Criteria
  - [ ] Checkbox items for what "done" looks like.
  
- Labels: suggest 1-3 from the available labels list. Only suggest labels that exist.
- Keep the original intent. Don't invent requirements the user didn't mention.
- Be concise. No fluff. Engineer-quality writing.
- Return ONLY valid JSON. No markdown code fences. No explanation.`;

  try {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY ?? '' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser's rough input:\n${rawInput}` }] },
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1500,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[issue-enhance] Gemini error:', res.status, errText);
      return NextResponse.json({ error: 'Gemini API error' }, { status: 502 });
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';

    // Parse JSON from response (strip markdown fences if present)
    let cleaned = rawText;
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const enhanced = JSON.parse(cleaned);
      return NextResponse.json({
        title: enhanced.title ?? title ?? '',
        body: enhanced.body ?? description ?? '',
        labels: Array.isArray(enhanced.labels) ? enhanced.labels : [],
        model: GEMINI_MODEL,
      });
    } catch {
      // If JSON parse fails, return cleaned text as body
      return NextResponse.json({
        title: title ?? '',
        body: cleaned || description || '',
        labels: [],
        model: GEMINI_MODEL,
      });
    }
  } catch (err) {
    console.error('[issue-enhance] Error:', err);
    return NextResponse.json({ error: 'Enhancement failed' }, { status: 500 });
  }
}
