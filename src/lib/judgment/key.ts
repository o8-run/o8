import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export const JUDGMENT_KEY_FILENAME = 'judgment-api-key';
export const JUDGMENT_KEY_ENV = 'O8_JUDGMENT_API_KEY';

export function judgmentKeyPath(): string {
  return path.join(getDataDir(), JUDGMENT_KEY_FILENAME);
}

/**
 * Resolve the judgment provider key: `O8_JUDGMENT_API_KEY`, else
 * `<data dir>/judgment-api-key`. The file must not be readable by group or
 * others (0600); a looser file is ignored with a warning that names the path,
 * never the contents. Returns null when no usable key exists.
 */
export function readJudgmentApiKey(): string | null {
  const fromEnv = process.env[JUDGMENT_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const keyPath = judgmentKeyPath();
  try {
    const mode = statSync(keyPath).mode;
    if ((process.platform !== 'win32' && (mode & 0o077) !== 0)) {
      console.warn(`[judgment] ignoring ${JUDGMENT_KEY_FILENAME}: file is readable by other users; run chmod 600 on it`);
      return null;
    }
    const key = readFileSync(keyPath, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}
