import { parse } from 'smol-toml';

/** Decode structured config before value matching; joined leaves cover split values. */
export function decodedMcpText(text: string): string {
  let decoded = text;
  for (let i = 0; i < 3; i++) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, part => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
    if (next === decoded) break;
    decoded = next;
  }
  const structured = decoded;
  try {
    const url = new URL(text);
    decoded += `\n${[url.username, url.password, url.pathname, url.hash, ...[...url.searchParams].flat()].join('')}`;
  } catch { /* Not a URL. */ }
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : [];
  const parsers: Array<(value: string) => unknown> = [value => JSON.parse(value), value => parse(value)];
  for (const parser of parsers) {
    try { decoded += `\n${strings(parser(structured)).join('')}`; break; } catch { /* Ordinary argument or URL. */ }
  }
  return decoded;
}
