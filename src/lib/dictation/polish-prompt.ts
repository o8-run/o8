/**
 * Polish prompt for dictation cleanup.
 *
 * Adapted from Symon's `polish.rs` build_prompt(). The adaptive-punctuation
 * block and OUTPUT COVERAGE guard prevent long dictations from being silently
 * summarized. The CodeEditor branch remains verbatim because o8 is a developer
 * surface, so polished output must preserve technical tokens, file paths in
 * backticks, and exact symbol casing.
 */

export type DictationSurface = 'orchestrator' | 'chat' | 'terminal' | 'general';

export interface DictationPolishContext {
  /** Currently-open file paths in the workspace, used as spelling anchors. */
  openFiles?: string[];
  /** Active repo path, for tone hints (the polish doesn't reference this directly). */
  activeRepoPath?: string | null;
  /** The saved custom dictionary (Settings > Voice): words to spell exactly. */
  dictionary?: string[];
  /** The saved custom polish instructions (Settings > Voice). */
  instructions?: string;
}

const MAX_DICTIONARY_WORDS = 200;
const MAX_DICTIONARY_WORD = 100;
const MAX_INSTRUCTIONS = 2000;

/** The dictionary words a caller sent, trimmed and bounded; anything else is dropped. */
function dictionaryWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((word): word is string => typeof word === 'string')
    .map(word => word.trim().slice(0, MAX_DICTIONARY_WORD))
    .filter(Boolean)
    .slice(0, MAX_DICTIONARY_WORDS);
}

/** Replace typographic quotes and primes with their ASCII forms. */
export function straightenQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

export function buildPolishSystemPrompt(
  surface: DictationSurface,
  context: DictationPolishContext = {},
): string {
  const surfaceLine = surfaceCoaching(surface);
  const fileAnchors = (context.openFiles ?? [])
    .filter((path) => typeof path === 'string' && path.trim().length > 0)
    .slice(0, 24);
  const fileBlock = fileAnchors.length > 0
    ? `Open files (use these for exact spelling of paths and symbols):\n${fileAnchors.map((path) => `- ${path}`).join('\n')}\n`
    : '';
  // The desktop's own polish lists the same two settings this way.
  const dictionary = dictionaryWords(context.dictionary);
  const dictionaryBlock = dictionary.length > 0
    ? `CUSTOM DICTIONARY (spell exactly as shown): ${dictionary.join(', ')}\n`
    : '';
  const instructions = typeof context.instructions === 'string'
    ? context.instructions.trim().slice(0, MAX_INSTRUCTIONS)
    : '';
  const instructionsBlock = instructions ? `USER INSTRUCTIONS: ${instructions}\n` : '';

  return [
    'You are a speech-to-text correction assistant for a developer using o8, an IDE for orchestrating AI coding agents.',
    'You receive an automatic transcript of the developer speaking. Return the cleaned-up final text — that and nothing else.',
    '',
    'Correction rules',
    '- Fix obvious recognizer errors (homophones, missed words, spliced words).',
    '- Preserve the speaker\'s wording where it was clear; do not replace a word the user pronounced clearly.',
    '- Common dev acronyms (API, TS, JSX, SQL, MCP, LLM, PR, CI, OAuth) are real — do not "correct" them to similar-sounding words.',
    '- Code identifiers should keep their casing exactly: camelCase, snake_case, kebab-case, SCREAMING_CASE.',
    '- Wrap file paths and symbol names in backticks when the developer is clearly referring to them as code (e.g. "open `src/app/page.tsx`").',
    '- Expand spoken numbers only if it reads more naturally; otherwise keep them as digits.',
    '',
    'Adaptive punctuation',
    '- Use commas for short pauses, periods for sentence ends, question marks where the intonation is questioning.',
    '- Use em dashes (—) for asides or sudden topic shifts. Use ellipses (…) for trailing off.',
    '- Use semicolons sparingly for tightly-coupled clauses. Use en dashes (–) for ranges.',
    '- Smart quotes (" "), not straight quotes, for prose.',
    '- Single newline between sentences if the speaker paused noticeably; otherwise keep on one line.',
    '',
    surfaceLine,
    '',
    fileBlock,
    dictionaryBlock,
    instructionsBlock,
    'Output coverage (required)',
    '- Output the full polished version of the transcript.',
    '- Do not summarize. Do not omit clauses. Do not add commentary.',
    '- If the user said something irrelevant or rambling, keep it — that is their choice to remove.',
    '- Do not add preamble like "Here is the polished version" — return only the corrected text.',
    '',
    'If the transcript is empty or contains only filler ("uh", "um"), return an empty string.',
  ].filter(Boolean).join('\n');
}

function surfaceCoaching(surface: DictationSurface): string {
  switch (surface) {
    case 'orchestrator':
      return 'Context: the user is dictating into the orchestrator chat. They are likely briefing an AI agent on a task: describing a bug, requesting a feature, pointing at a file or symbol. Keep the tone direct and technical. If they reference a file or symbol, format it as code.';
    case 'chat':
      return 'Context: the user is dictating into a casual AI chat. They may be asking a question or thinking out loud. Keep punctuation natural; do not over-formalize.';
    case 'terminal':
      return 'Context: the user is dictating into a terminal command surface. The output may be a shell command. Preserve flags and arguments exactly. Do not add explanations.';
    case 'general':
    default:
      return 'Context: the user is dictating into a general text input. Apply the rules above.';
  }
}
