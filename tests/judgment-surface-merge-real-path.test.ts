import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'judgment-surfaces-'));
  roots.push(root);
  const copy = (file: string) => {
    if (!existsSync(file)) return;
    const target = join(root, file);
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(file, target, { recursive: true });
  };
  for (const file of ['scripts/judgment-replay.mjs', 'scripts/judgment-labels',
    'src/lib/judgment/questions.ts', 'src/lib/judgment/questions', 'src/lib/judgment/types.ts']) copy(file);
  for (const file of readdirSync('scripts/lib').filter(file => file.startsWith('judgment-replay'))) copy(`scripts/lib/${file}`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' } }));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndata/\n');
  symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'junction');
  git(root, 'init', '-q', '-b', 'base');
  git(root, 'config', 'user.name', 'o8 fixture');
  git(root, 'config', 'user.email', 'fixture@o8.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base fixture');
  return root;
}

function addSurface(root: string, surface: 'alpha' | 'beta') {
  git(root, 'checkout', '-qb', `surface-${surface}`, 'base');
  mkdirSync(join(root, 'src/lib/judgment/questions'), { recursive: true });
  mkdirSync(join(root, 'scripts/judgment-labels'), { recursive: true });
  const name = `fixture${surface === 'alpha' ? 'Alpha' : 'Beta'}`;
  writeFileSync(join(root, `src/lib/judgment/questions/${surface}.ts`),
    `/** Calibration fixture; independent surface ${surface}. */\nexport const QUESTION = { type: 'noul', instructions: '${surface} question' } as const;\n`);
  writeFileSync(join(root, `scripts/judgment-labels/${surface}.mjs`), `export default {
    name: '${name}', kind: 'recorded', order: 1000,
    async load() { return (await import('../../src/lib/judgment/questions/${surface}.ts')).QUESTION; },
    label(question) { return { rows: [], notes: { question: question.instructions } }; },
    render({ notes }) { return { text: '${name}: ' + notes.question, result: { n: 0 } }; },
  };\n`);
  git(root, 'add', `src/lib/judgment/questions/${surface}.ts`, `scripts/judgment-labels/${surface}.mjs`);
  git(root, 'commit', '-qm', `add ${surface} surface`);
}

function replay(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ['scripts/judgment-replay.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { NODE_ENV: 'test', PATH: process.env.PATH, O8_DATA_DIR: join(root, 'data') },
  });
}

it.each([['alpha', 'beta'], ['beta', 'alpha']] as const)(
  'merges independent surfaces in %s/%s order and discovers both through the replay command', (first, second) => {
    const root = fixture();
    const questions = readFileSync(join(root, 'src/lib/judgment/questions.ts'), 'utf8');
    const command = readFileSync(join(root, 'scripts/judgment-replay.mjs'), 'utf8');
    addSurface(root, 'alpha');
    addSurface(root, 'beta');
    git(root, 'checkout', '-qb', 'combined', 'base');
    git(root, 'merge', '--no-edit', `surface-${first}`);
    git(root, 'merge', '--no-edit', `surface-${second}`);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, 'src/lib/judgment/questions.ts'), 'utf8')).toBe(questions);
    expect(readFileSync(join(root, 'scripts/judgment-replay.mjs'), 'utf8')).toBe(command);
    const help = replay(root, '--help');
    expect(help.status, help.stderr).toBe(0);
    for (const surface of ['alpha', 'beta'] as const) {
      const name = `fixture${surface === 'alpha' ? 'Alpha' : 'Beta'}`;
      expect.soft(help.stdout).toContain(name);
      const result = replay(root, '--label', name);
      expect.soft(result.status, result.stderr).toBe(0);
      expect.soft(result.stdout).toContain(`${name}: ${surface} question`);
    }
  },
);
