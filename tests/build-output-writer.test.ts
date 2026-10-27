import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const require = createRequire(import.meta.url);
const writerModule = require.resolve('../scripts/lib/build-output-writer.cjs');
const nativeWriter = require(writerModule) as typeof import('../scripts/lib/build-output-writer.cjs');
function createBuildOutputWriter(scope: string) {
  const stat = lstatSync(scope);
  return nativeWriter.createBuildOutputWriter(scope, { device: stat.dev, inode: stat.ino });
}

it.each(['chmodSync', 'utimesSync'] as const)('does not adopt a replacement after descriptor %s', async method => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-metadata-');
  const scope = path.join(root, 'output'); mkdirSync(scope);
  const file = path.join(scope, 'proof');
  const script = `
    const fs = require('node:fs'); const path = require('node:path');
    const method = ${JSON.stringify(method)};
    const descriptorMethod = method === 'chmodSync' ? 'fchmodSync' : 'futimesSync';
    const original = fs[descriptorMethod];
    fs[descriptorMethod] = (...args) => {
      const result = original(...args);
      // Replace after the real metadata syscall, before its receipt is issued.
      fs.renameSync(${JSON.stringify(file)}, ${JSON.stringify(path.join(root, 'original'))});
      fs.writeFileSync(${JSON.stringify(file)}, 'foreign metadata bytes');
      return result;
    };
    const root = fs.lstatSync(${JSON.stringify(scope)});
    const writer = require(${JSON.stringify(writerModule)}).createBuildOutputWriter(${JSON.stringify(scope)}, {device:root.dev,inode:root.ino});
    try {
      writer.api.writeFileSync(${JSON.stringify(file)}, 'compiler bytes');
      writer.api[method](${JSON.stringify(file)}, ...(method === 'chmodSync' ? [0o600] : [new Date(1000), new Date(1000)]));
      const stat = fs.lstatSync(${JSON.stringify(file)});
      const entry = { relative:'proof',device:stat.dev,inode:stat.ino,kind:'file',mode:stat.mode,
        linkCount:stat.nlink,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs };
      try { writer.prove([entry]); throw new Error('Replacement was adopted'); }
      catch (error) { if (!/Preserved unowned/.test(error.message)) throw error; }
      try { writer.api.unlinkSync(${JSON.stringify(file)}); throw new Error('Replacement was deleted'); }
      catch (error) { if (!/Preserved unowned/.test(error.message)) throw error; }
    } finally { writer.close(); }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe('foreign metadata bytes');
});

it.each(['sync', 'promise'] as const)('refuses foreign numeric truncation flags through %s open', async style => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-flags-');
  const writer = createBuildOutputWriter(root);
  const file = path.join(root, 'foreign'); writeFileSync(file, 'foreign open bytes');
  try {
    const { constants } = require('node:fs') as typeof import('node:fs');
    const flags = constants.O_WRONLY | constants.O_TRUNC | constants.O_EXCL;
    if (style === 'sync') expect(() => writer.api.openSync(file, flags)).toThrow(/Preserved unowned/);
    else await expect(writer.promises.open(file, flags)).rejects.toThrow(/Preserved unowned/);
    expect(readFileSync(file, 'utf8')).toBe('foreign open bytes');
  } finally { writer.close(); }
});

it('preserves executable modes through descriptor-owned synchronous and promise copies', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-mode-');
  const scope = path.join(root, 'output'); mkdirSync(scope);
  const source = path.join(root, 'helper'); writeFileSync(source, 'fixture executable'); chmodSync(source, 0o755);
  const writer = createBuildOutputWriter(scope);
  try {
    writer.api.copyFileSync(source, path.join(scope, 'sync-helper'));
    await writer.promises.copyFile(source, path.join(scope, 'promise-helper'));
    for (const name of ['sync-helper', 'promise-helper']) {
      expect(lstatSync(path.join(scope, name)).mode & 0o777).toBe(0o755);
      expect(readFileSync(path.join(scope, name), 'utf8')).toBe('fixture executable');
    }
  } finally { writer.close(); }
});

it('checks original ownership again at every environment scrub delete', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-delete-');
  const writer = createBuildOutputWriter(root);
  try {
    const files = ['.env', '.env.production'].map(name => path.join(root, name));
    for (const file of files) writer.api.writeFileSync(file, 'compiler copy');
    writer.api.unlinkSync(files[0]);
    renameSync(files[1], path.join(root, 'previous-copy'));
    writeFileSync(files[1], 'replacement between deletes');
    expect(() => writer.api.unlinkSync(files[1])).toThrow(/Preserved unowned/);
    expect(existsSync(files[0])).toBe(false);
    expect(readFileSync(files[1], 'utf8')).toBe('replacement between deletes');
  } finally { writer.close(); }
});

it('rotates an owned cache file and refuses a foreign rename destination', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-rename-');
  const writer = createBuildOutputWriter(root);
  const source = path.join(root, 'new.pack'); const destination = path.join(root, 'index.pack');
  try {
    writer.api.writeFileSync(source, 'new cache'); writer.api.writeFileSync(destination, 'previous cache');
    writer.api.renameSync(source, destination);
    expect(readFileSync(destination, 'utf8')).toBe('new cache');
    writer.api.writeFileSync(source, 'next cache');
    renameSync(destination, path.join(root, 'previous.pack')); writeFileSync(destination, 'foreign cache');
    expect(() => writer.api.renameSync(source, destination)).toThrow(/Preserved unowned/);
    expect(readFileSync(destination, 'utf8')).toBe('foreign cache');
    expect(readFileSync(source, 'utf8')).toBe('next cache');
  } finally { writer.close(); }
});

it('requires observed closure for every birth-bound writer before publication', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-close-');
  const writer = createBuildOutputWriter(root);
  const identity = { version: 1 as const, platform: 'linux' as const, bootId: 'fixture-boot', startId: 'fixture-start' };
  try {
    writer.admit(123, identity);
    expect(() => writer.prove([])).toThrow(/no observed close/);
    writer.observedClose(123, identity);
    expect(() => writer.prove([])).not.toThrow();
  } finally { writer.close(); }
});

it.each(['directory', 'symlink'] as const)('keeps a replacement arriving after native %s creation but before its receipt is claimed', async kind => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-create-');
  const scope = path.join(root, 'output'); mkdirSync(scope);
  const file = path.join(scope, 'new-entry'); const donor = path.join(root, 'donor'); writeFileSync(donor, 'donor bytes');
  const script = `
    const fs = require('node:fs'); const cp = require('node:child_process'); const spawn = cp.spawnSync;
    cp.spawnSync = (command,args,options) => {
      const result = spawn(command,args,options);
      if (args[0] === ${JSON.stringify(require.resolve('../scripts/lib/build-output-entry-create.cjs'))} && result.status === 0) {
        const actor = spawn(process.execPath,['-e',
          "const fs=require('node:fs');fs.renameSync(process.argv[1],process.argv[2]);if(process.argv[3]==='directory'){fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/foreign','foreign directory bytes');}else fs.symlinkSync(process.argv[4],process.argv[1]);",
          ${JSON.stringify(file)},${JSON.stringify(path.join(root, 'original'))},${JSON.stringify(kind)},${JSON.stringify(donor)}],
          {env:{PATH:process.env.PATH,NODE_ENV:'test'},encoding:'utf8'});
        if (actor.status) throw new Error(actor.stderr);
      }
      return result;
    };
    const root=fs.lstatSync(${JSON.stringify(scope)});
    const writer=require(${JSON.stringify(writerModule)}).createBuildOutputWriter(${JSON.stringify(scope)},{device:root.dev,inode:root.ino});
    try {
      try {
        ${kind === 'directory' ? `writer.api.mkdirSync(${JSON.stringify(file)});` : `writer.api.symlinkSync(${JSON.stringify(donor)},${JSON.stringify(file)});`}
        throw new Error('Foreign creation was adopted');
      } catch(error) { if (!/Preserved unowned/.test(error.message)) throw error; }
      try { writer.api.rmSync(${JSON.stringify(file)},{recursive:true}); throw new Error('Foreign creation was deleted'); }
      catch(error) { if (!/Preserved unowned/.test(error.message)) throw error; }
    } finally { writer.close(); }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(kind === 'directory' ? path.join(file, 'foreign') : donor, 'utf8'))
    .toBe(kind === 'directory' ? 'foreign directory bytes' : 'donor bytes');
});

it.each(['empty-destination', 'owned-destination', 'publication'] as const)('never clobbers a destination inserted at the native move: %s', async scenario => {
  const root = await createRetainedGeneratedOutputFixture('o8-writer-move-');
  const output = path.join(root, '.next'); mkdirSync(output);
  const scope = path.join(output, '.o8-release-build'); mkdirSync(scope);
  const from = path.join(scope, 'BUILD_ID');
  const destination = path.join(scenario === 'publication' ? output : scope, 'destination');
  const actualDestination = scenario === 'publication' ? path.join(output, 'BUILD_ID') : destination;
  const script = `
    const fs=require('node:fs');const cp=require('node:child_process');const link=fs.linkSync;
    fs.linkSync=(source,destination) => {
      const actor=cp.spawnSync(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'foreign move destination',{flag:'wx'})",destination],
        {env:{PATH:process.env.PATH,NODE_ENV:'test'},encoding:'utf8'});
      if(actor.status)throw new Error(actor.stderr);
      return link(source,destination);
    };
    const root=fs.lstatSync(${JSON.stringify(scope)});
    const writer=require(${JSON.stringify(writerModule)}).createBuildOutputWriter(${JSON.stringify(scope)},{device:root.dev,inode:root.ino});
    try {
      writer.api.writeFileSync(${JSON.stringify(from)},'owned move source');
      ${scenario === 'owned-destination' ? `writer.api.writeFileSync(${JSON.stringify(destination)},'old owned destination');` : ''}
      try {
        ${scenario === 'publication' ? `
          const inventory=['.','BUILD_ID'].map(relative => {
            const stat=fs.lstatSync(relative==='.'?${JSON.stringify(scope)}:${JSON.stringify(from)});
            return {relative,device:stat.dev,inode:stat.ino,kind:stat.isDirectory()?'directory':'file',mode:stat.mode,linkCount:stat.nlink,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
          });
          writer.prove(inventory);const parent=fs.lstatSync(${JSON.stringify(output)});
          writer.promote({canonicalPath:${JSON.stringify(output)},device:parent.dev,inode:parent.ino},inventory);
        ` : `writer.api.renameSync(${JSON.stringify(from)},${JSON.stringify(destination)});`}
        throw new Error('Foreign move destination was overwritten');
      } catch(error) { if(error.code!=='EEXIST' && !/Preserved unowned/.test(error.message))throw error; }
    } finally { writer.close(); }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(actualDestination, 'utf8')).toBe('foreign move destination');
  expect(readFileSync(from, 'utf8')).toBe('owned move source');
});
