import 'server-only';

import { tokenizeForGrep } from '@/lib/cortex/qa/literal-lookup';
import { readWorkspaceFile } from '@/lib/fs/workspace-file';
import type { TypedRow } from '@/lib/cortex/qa/types';
import { buildStrongGrepTopRowsImpl } from './eval/strong-grep-baseline';

export async function buildGrepArmTopRows(
  question: string,
  repoPath: string | undefined,
): Promise<TypedRow[]> {
  return buildStrongGrepTopRowsImpl(question, repoPath, {
    tokenize: tokenizeForGrep,
    fallback: async () => [],
    // A hit is read without following links and must resolve inside repoPath.
    readFile: async (root, relPath) => (await readWorkspaceFile(root, relPath)).bytes.toString('utf-8'),
  });
}
