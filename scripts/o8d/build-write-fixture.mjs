// Verification-only builder. No checkout mutation, no writes to application stores.
// Usage: node build-write-fixture.mjs ROOT TARGET OUTPUT [BASE CANDIDATE_PATCH]
// After integration omit BASE/CANDIDATE_PATCH: ROOT is the candidate checkout.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [rootArg, targetArg, outputArg, base, candidateArg] = process.argv.slice(2);
if (!rootArg || !targetArg || !outputArg || Boolean(base) !== Boolean(candidateArg)) {
  throw new Error('Expected ROOT TARGET OUTPUT [BASE CANDIDATE_PATCH]');
}
const root = resolve(rootArg), target = resolve(targetArg), output = resolve(outputArg);
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'verification-fixture.patch');
if (existsSync(output) || existsSync(output + '.json')) throw new Error('Refusing to replace existing evidence output');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
  return result.stdout;
}
function disk() {
  run('df', ['-h', '/']);
  // The portable Node API also works with BSD df on macOS. Keep CI's default;
  // an operator can set a smaller local budget, bounded below by 5 GiB.
  const minimum = Number(process.env.O8D_FIXTURE_MIN_FREE_GIB ?? 15);
  if (!Number.isFinite(minimum) || minimum < 5) throw new Error('Disk minimum must be at least 5 GiB');
  const { bavail, bsize } = statfsSync('/');
  if (bavail * bsize < minimum * 1024 ** 3) throw new Error(`Less than ${minimum}GiB available`);
}
disk();
const scratch = mkdtempSync(join(tmpdir(), 'o8d-write-fixture-build-'));
try {
  // An exported crate, not a third worktree. No .git, npm install or TS tree.
  if (base) {
    const archive = run('git', ['-C', root, 'archive', base, 'crates/o8d'], { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
    run('tar', ['-xf', '-', '-C', scratch], { input: archive, stdio: ['pipe', 'inherit', 'inherit'] });
    run('git', ['apply', '--include=crates/o8d/**', resolve(candidateArg)], { cwd: scratch });
  } else {
    cpSync(join(root, 'crates/o8d'), join(scratch, 'crates/o8d'), {
      recursive: true, filter: source => !['target', '.git'].includes(source.split('/').at(-1)),
    });
  }
  const crate = join(scratch, 'crates/o8d');
  const production = Object.fromEntries(['src/app.rs', 'src/app/native.rs', 'src/http/mod.rs', 'native-routes.json', 'Cargo.lock']
    .map(path => [path, hash(readFileSync(join(crate, path)))]));
  run('git', ['apply', fixture], { cwd: scratch });
  // Distinct binary name prevents contaminating the reusable application cache.
  const manifest = join(crate, 'Cargo.toml');
  const before = readFileSync(manifest, 'utf8');
  const bin = '[[bin]]\nname = "o8d"\n';
  if (!before.includes(bin)) throw new Error('Expected explicit o8d binary definition');
  writeFileSync(manifest, before.replace(bin, '[[bin]]\nname = "o8d-write-fixture"\n'));
  disk();
  const args = ['build', '--locked', '--manifest-path', manifest, '--bin', 'o8d-write-fixture', '--features', 'experimental-session-reads', '--target-dir', target];
  run('cargo', args);
  const binary = join(target, 'debug/o8d-write-fixture');
  cpSync(binary, output, { errorOnExist: true, force: false });
  writeFileSync(output + '.json', JSON.stringify({ kind: 'verification-only', base: base ?? null,
    production, fixture: hash(readFileSync(fixture)), candidate: candidateArg ? hash(readFileSync(resolve(candidateArg))) : null,
    binary: hash(readFileSync(output)), cargo: args.map(arg => arg.replace(scratch, '<exported-crate>')) }, null, 2) + '\n');
  console.log(`Fixture built: ${output}`);
} finally {
  // Only this invocation's temporary exported crate; all dependency caches retained.
  rmSync(scratch, { recursive: true, force: true });
}
