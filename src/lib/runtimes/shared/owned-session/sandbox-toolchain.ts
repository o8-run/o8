import path from 'node:path';

/**
 * HOME paths the worker toolchain needs, shared by the macOS (seatbelt) and
 * Linux (bubblewrap) worker sandbox backends so both grant the same set.
 */
export interface HomeToolchainPolicy {
  /** User-owned CLI/global prefixes: readable, never writable. */
  readDirs: string[];
  /** Caches and model-CLI session state: readable and writable. */
  writeDirs: string[];
  /** Individual dotfiles the CLIs read (git identity, npm registry, etc.). */
  files: string[];
  /** Individual dotfiles the CLIs rewrite. */
  mutableFiles: string[];
  /** Credentials and launch policy that stay immutable inside writeDirs. */
  immutablePaths: string[];
}

export function homeToolchainPolicy(home: string): HomeToolchainPolicy {
  const inHome = (entries: string[]) => Array.from(new Set(entries.map((entry) => path.join(home, entry))));
  return {
    readDirs: inHome([
      '.nvm', '.volta', '.n', '.local', '.npm-global', '.config', '.asdf',
      '.rustup', '.cargo', '.bun', '.deno', 'bin', 'Library/pnpm',
    ]),
    // Normal packet work writes caches and model-CLI session state. Global
    // executable prefixes remain read-only above so a worker cannot persist a
    // replacement npm/cargo binary outside its packet.
    writeDirs: inHome([
      '.npm', '.cache', '.yarn', '.pnpm-store',
      path.join('.cargo', 'registry'), path.join('.cargo', 'git'),
      path.join('.bun', 'install', 'cache'), '.deno', '.codex', '.claude', '.gemini',
      path.join('.config', 'gemini'),
    ]),
    // `.zshenv` is deliberately ABSENT: it commonly exports the operator's API
    // keys, and workers inherit their env from the trusted parent — a shell
    // that can't read it just skips it.
    files: inHome(['.gitconfig', '.gitignore', '.npmrc', '.yarnrc']),
    // Claude Code 2.1.x persists per-project/session state in this legacy root
    // file even when its main state directory is ~/.claude.
    mutableFiles: inHome(['.claude.json']),
    // Keep model credentials and launch policy immutable even though the CLIs
    // need mutable session databases inside the same home directories.
    immutablePaths: inHome([
      '.codex/auth.json', '.codex/config.toml', '.codex/AGENTS.md',
      '.codex/agents', '.codex/plugins', '.codex/rules', '.codex/skills',
      '.claude/.credentials.json', '.claude/settings.json', '.claude/settings.local.json',
      '.claude/agents', '.claude/hooks', '.claude/mcp-servers', '.claude/plugins',
      '.claude/skills', '.claude/statusline.sh',
      '.gemini/google_accounts.json', '.gemini/settings.json', '.gemini/policies',
      '.gemini/skills', '.gemini/trustedFolders.json',
    ]),
  };
}
