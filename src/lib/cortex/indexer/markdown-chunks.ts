const HARD_CHUNK_CAP = 2000;
const MIN_CHUNK_LEN = 100;

interface DocChunk {
  chunkIdx: number;
  headingPath: string[];
  text: string;
}

interface HeadingSection {
  headingPath: string[];
  text: string;
}

function splitOnHeading(
  body: string,
  level: number,
  parentPath: string[] = [],
): HeadingSection[] {
  const pattern = level === 2 ? /^##\s+(.+?)\s*$/gm : /^###\s+(.+?)\s*$/gm;
  const matches: Array<{ start: number; end: number; title: string }> = [];
  for (const m of body.matchAll(pattern)) {
    if (m.index === undefined) continue;
    matches.push({ start: m.index, end: m.index + m[0].length, title: m[1] });
  }
  if (matches.length === 0) {
    return [{ headingPath: [...parentPath], text: body }];
  }
  const sections: HeadingSection[] = [];
  if (matches[0].start > 0) {
    const prelude = body.slice(0, matches[0].start);
    if (prelude.trim().length > 0) {
      sections.push({ headingPath: [...parentPath], text: prelude });
    }
  }
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const next = matches[i + 1];
    const sectionEnd = next ? next.start : body.length;
    sections.push({
      headingPath: [...parentPath, cur.title.trim()],
      text: body.slice(cur.end, sectionEnd),
    });
  }
  return sections;
}

function splitOnParagraph(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const out: string[] = [];
  let buffer = '';
  for (const para of paragraphs) {
    if (buffer.length === 0) {
      buffer = para;
      continue;
    }
    if (buffer.length + para.length + 2 > HARD_CHUNK_CAP) {
      out.push(buffer);
      buffer = para;
    } else {
      buffer += '\n\n' + para;
    }
  }
  if (buffer.length > 0) out.push(buffer);
  return out;
}

export function chunkMarkdown(body: string): DocChunk[] {
  const normalized = body.replace(/\r\n/g, '\n');
  const sections = splitOnHeading(normalized, 2);
  const out: DocChunk[] = [];
  let chunkIdx = 0;

  for (const section of sections) {
    if (section.text.length <= HARD_CHUNK_CAP) {
      if (section.text.trim().length >= MIN_CHUNK_LEN) {
        out.push({ chunkIdx: chunkIdx++, headingPath: section.headingPath, text: section.text.trim() });
      }
      continue;
    }
    const subsections = splitOnHeading(section.text, 3, section.headingPath);
    for (const sub of subsections) {
      if (sub.text.length <= HARD_CHUNK_CAP) {
        if (sub.text.trim().length >= MIN_CHUNK_LEN) {
          out.push({ chunkIdx: chunkIdx++, headingPath: sub.headingPath, text: sub.text.trim() });
        }
        continue;
      }
      for (const para of splitOnParagraph(sub.text)) {
        const text = para.trim();
        if (text.length < MIN_CHUNK_LEN) continue;
        out.push({
          chunkIdx: chunkIdx++,
          headingPath: sub.headingPath,
          text: text.length > HARD_CHUNK_CAP ? text.slice(0, HARD_CHUNK_CAP) : text,
        });
      }
    }
  }
  return out;
}
