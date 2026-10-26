import { CREDENTIAL_KEY } from './output-redaction-matchers';

/** Consume a complete source statement, retaining quote/bracket state at newlines. */
function statementEnd(text: string, start: number): number {
  const brackets: string[] = [];
  let quote = ''; let triple = false; let lineComment = false; let blockComment = false;
  for (let i = start; i < text.length; i++) {
    const character = text[i];
    if (lineComment) {
      if (character === '\n' || character === '\r') { lineComment = false; if (!brackets.length) return i; }
      continue;
    }
    if (blockComment) { if (text.slice(i, i + 2) === '*/') { blockComment = false; i++; } continue; }
    if (!quote && (character === '#' || text.slice(i, i + 2) === '//')) { lineComment = true; continue; }
    if (!quote && text.slice(i, i + 2) === '/*') { blockComment = true; i++; continue; }
    if (character === '\\') { i++; continue; }
    if (quote) {
      if (triple ? text.slice(i, i + 3) === quote.repeat(3) : character === quote) {
        if (triple) i += 2;
        quote = ''; triple = false;
      }
    } else if ('"\'`'.includes(character)) {
      quote = character; triple = text.slice(i, i + 3) === quote.repeat(3); if (triple) i += 2;
    } else if ('([{'.includes(character)) brackets.push(character);
    else if (')]}'.includes(character)) {
      const expected: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
      if (brackets.pop() !== expected[character]) return text.length;
    } else if ((character === '\n' || character === '\r') && !brackets.length) return i;
  }
  return text.length;
}
export function assignmentRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const keys = new RegExp(CREDENTIAL_KEY + '["\']?(?:\\s*\\])*\\s*([:=])', 'gi');
  for (const match of text.matchAll(keys)) {
    const valueStart = match.index + match[0].length;
    let end = statementEnd(text, valueStart);
    if (match[1] === ':' && !/^\s*[A-Za-z_][\w.[\], |]*\s*=/.test(text.slice(valueStart, text.indexOf('\n', valueStart) < 0 ? undefined : text.indexOf('\n', valueStart)))) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const indentation = text.slice(lineStart).match(/^[ \t]*/)?.[0].length ?? 0;
      let next = text.indexOf('\n', valueStart);
      while (next !== -1 && next + 1 < text.length) {
        const lineEnd = text.indexOf('\n', next + 1);
        const stop = lineEnd < 0 ? text.length : lineEnd;
        const line = text.slice(next + 1, stop);
        const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
        if (line.trim() && indent <= indentation) break;
        end = Math.max(end, stop); next = lineEnd;
      }
    }
    ranges.push({ start: match.index, end });
  }
  const prefixes = /\bprocess\s*\.\s*env\s*\[[\s\S]*?\]\s*=|(?<!\S)(?:--(?:user|password|token|api-key)(?:\s+|=)|-u\s*)/gi;
  for (const match of text.matchAll(prefixes)) ranges.push({ start: match.index, end: statementEnd(text, match.index + match[0].length) });
  return ranges;
}
