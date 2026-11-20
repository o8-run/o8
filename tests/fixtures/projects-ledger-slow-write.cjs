// Widen the real truncate-before-write window on the owned fixture ledger.
// The replacement writes temp paths instead, so readers keep the prior file.
const fs = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.writeFile;
const path = require('node:path');
const { existsSync, writeFileSync } = require('node:fs');
let pausedRepoint = false;
fs.writeFile = async function (file, data, options) {
  if (typeof file === 'string' && (file.endsWith('/projects.json') || path.basename(file).startsWith('.projects-')) && typeof data === 'string' && data.includes('/last') && !pausedRepoint) {
    pausedRepoint = true;
    const directory = path.dirname(file);
    writeFileSync(path.join(directory, 'repoint-ready'), 'ready');
    const deadline = Date.now() + 2000;
    while (!existsSync(path.join(directory, 'repoint-release')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  if (typeof file !== 'string' || !file.endsWith('/projects.json')) return original(file, data, options);
  const handle = await fs.open(file, 'w');
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    return await original(handle, data, options);
  } finally { await handle.close(); }
};
syncBuiltinESMExports();
