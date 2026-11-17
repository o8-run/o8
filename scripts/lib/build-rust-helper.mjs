import { releaseCompileEnvironment } from './release-compile-cache.mjs';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function buildRustHelper({ root, crate, name: NAME, label, features = [], linux = false }) {
  const compileEnv = releaseCompileEnvironment(root);
  const targetDir = join(crate, 'target');
  const helpersDir = join(root, 'src-tauri', 'helpers');
  const SLICES = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  const LINUX_TRIPLES = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'];
  const requestedTarget = process.env.O8_TAURI_BUILD_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || '';
  const universal = requestedTarget === 'universal-apple-darwin';

  if (process.platform !== 'darwin' && (!linux || process.platform !== 'linux')) {
    console.log(`[${label}] ${process.platform} — skipping`);
    return;
  }

  mkdirSync(helpersDir, { recursive: true });
  const staged = [NAME, ...['aarch64', 'x86_64', 'universal'].map((arch) => `${NAME}-${arch}-apple-darwin`)]
    .map((name) => join(helpersDir, name));
  const stagedLinux = LINUX_TRIPLES.map((triple) => join(helpersDir, `${NAME}-${triple}`));
  for (const path of [...staged, ...stagedLinux]) rmSync(path, { force: true });

  function build(triple) {
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(crate, 'Cargo.toml'),
      ...(features.length ? ['--features', features.join(',')] : []), '--bin', NAME, '--target', triple, '--target-dir', targetDir], { stdio: 'inherit', env: compileEnv, timeout: 15 * 60_000 });
    return join(targetDir, triple, 'release', NAME);
  }

  try {
    if (universal) {
      const slices = SLICES.map(build);
      const fat = join(targetDir, 'universal-apple-darwin', NAME);
      mkdirSync(dirname(fat), { recursive: true });
      execFileSync('lipo', ['-create', '-output', fat, ...slices], { stdio: 'inherit' });
      for (const path of staged) copyFileSync(fat, path);
    } else {
      const supported = process.platform === 'linux' ? LINUX_TRIPLES : SLICES;
      const triple = supported.includes(requestedTarget) ? requestedTarget
        : execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)$/m)?.[1];
      if (!supported.includes(triple)) throw new Error(`unsupported target ${triple}`);
      const thin = build(triple);
      for (const path of [staged[0], join(helpersDir, `${NAME}-${triple}`)]) copyFileSync(thin, path);
    }
  } catch (error) {
    console.error(`[${label}] build failed (${error.message}); refusing to stage a helper`);
    process.exit(1);
  }
  console.log(`[${label}] staged ${NAME} → helpers/ (${universal ? 'universal' : 'thin'})`);
}
