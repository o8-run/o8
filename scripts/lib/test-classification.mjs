import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Match Vitest's production include contract exactly. Fixture files with other
// extensions are helpers, not independently scheduled tests.
const TEST_FILE_RE = /\.test\.ts$/;
const TEST_ROOTS = ['src', 'tests', 'cli'];
const EXTRA_TEST_FILES = new Set([
  'src/components/desktop/file-viewer/RichMarkdownEditor.test.tsx',
  'src/components/desktop/thoughts/chat-panel/useComposerAutosize.test.tsx',
  'src/components/desktop/thoughts/chat-panel/useComposerDraftLifecycle.test.tsx',
]);

const PATH_RULES = [
  ['real-path', /(?:^|[-/])real-path(?:[-.]|$)/i],
  ['real-git', /(?:^|[-/])real-git(?:[-.]|$)/i],
  ['integration', /(?:^|[-/])integration(?:[-.]|$)/i],
  ['apfs', /(?:^|[-/])apfs(?:[-.]|$)/i],
  ['worktree', /(?:^|[-/])worktree(?:[-.]|$)/i],
];

const SOURCE_RULES = [
  ['stdio-json-rpc-peer', /\bnew\s+StdioJsonRpcPeer\s*\(/],
  ['child-process', /(?:node:)?child_process|\bspawnSync?\s*\(|\bexecFile(?:Sync)?\s*\(|\bexecSync\s*\(/],
  ['executable-fixture', /\bchmodSync\s*\(|#!\/usr\/bin\/env (?:node|bash|sh)\b/],
  ['fixture-lifecycle', /test-fixture-lifecycle/],
  ['process-signal', /process\.kill\s*\(|\bSIG(?:INT|TERM|KILL)\b/],
  ['git-cli', /['"`]git['"`]|\bgit (?:init|clone|worktree|commit|checkout|merge|rebase)\b/i],
  ['worktree-api', /WorktreeManager|createWorktree|removeWorktree|\.cortex-worktrees/],
  ['apfs-tool', /\b(?:hdiutil|diskutil|mount_apfs|apfs)\b/i],
  ['terminal-tool', /\b(?:tmux|lsof|pgrep|pkill)\b/i],
  ['terminal-host', /createChildTerminalHost|terminal-host/i],
  ['network-listener', /createServer\s*\(|WebSocketServer|\.listen\s*\(/],
  ['native-build', /\b(?:cargo|rustc|swift|xcodebuild|codesign|notarytool)\b/i],
];

function walkTestFiles(root, directory, results) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walkTestFiles(root, absolute, results);
    else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join('/');
      if (TEST_FILE_RE.test(entry.name) || EXTRA_TEST_FILES.has(path)) results.push(path);
    }
  }
}

export function classifyTestSource(path, source) {
  const reasons = [];
  for (const [reason, pattern] of PATH_RULES) {
    if (pattern.test(path)) reasons.push(reason);
  }
  for (const [reason, pattern] of SOURCE_RULES) {
    if (pattern.test(source)) reasons.push(reason);
  }
  return [...new Set(reasons)].sort();
}

export function buildTestClassificationReport(root) {
  const files = [];
  for (const testRoot of TEST_ROOTS) {
    const absolute = join(root, testRoot);
    try { walkTestFiles(root, absolute, files); } catch {}
  }
  files.sort();
  const resourceOwning = files.flatMap((path) => {
    const reasons = classifyTestSource(path, readFileSync(join(root, path), 'utf8'));
    return reasons.length > 0 ? [{ path, reasons }] : [];
  });
  return {
    hermeticFiles: files.filter(path => !resourceOwning.some(entry => entry.path === path)),
    manifest: {
      schema: 'o8/test-classification/v1',
      generatedBy: 'node scripts/classify-tests.mjs --write',
      resourceOwning,
    },
    hermeticTests: files.length - resourceOwning.length,
    resourceOwningTests: resourceOwning.length,
  };
}

export function buildTestClassification(root) {
  return buildTestClassificationReport(root).manifest;
}

export const testClassificationInternals = {
  PATH_RULES,
  SOURCE_RULES,
  TEST_FILE_RE,
};
