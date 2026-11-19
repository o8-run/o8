const fs = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');

async function main() {
  const options = JSON.parse(process.argv[2]);
  const directory = process.env.O8_DATA_DIR;
  const target = path.join(directory, 'projects.json');
  const before = '{"projects":[],"marker":"before"}';
  const after = '{"projects":[],"marker":"after"}';
  if (options.existingMode !== null) {
    await fs.writeFile(target, before);
    await fs.chmod(target, options.existingMode);
  }
  process.umask(options.umask);
  const originalWrite = fs.writeFile;
  const temporaryModes = [];
  const flags = [];
  const targetDuringWrite = [];
  fs.writeFile = async function (file, data, config) {
    const result = await originalWrite(file, data, config);
    if (path.basename(file).startsWith('.projects-')) {
      temporaryModes.push((await fs.stat(file)).mode & 0o777);
      flags.push(config.flag);
      targetDuringWrite.push(await fs.readFile(target, 'utf8').catch(error => error.code));
    }
    return result;
  };
  syncBuiltinESMExports();
  const { writeProjectsLedgerAtomically } = require('../../src/lib/repos/projects-ledger-writer.ts');
  await writeProjectsLedgerAtomically(after);
  console.log(JSON.stringify({ mode: (await fs.stat(target)).mode & 0o777, contents: await fs.readFile(target, 'utf8'),
    temporaryModes, flags, targetDuringWrite, files: await fs.readdir(directory) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
