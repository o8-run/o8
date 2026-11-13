#!/usr/bin/env node
/** Read-only runtime diagnosis on a private Xvfb display; never installation. */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, openSync, closeSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [payloadArg, outputArg, appimageArg] = process.argv.slice(2);
if (!payloadArg || !outputArg || !process.env.DISPLAY) {
  throw new Error('Usage on private Xvfb: diagnose-payload.mjs EXTRACTED_ROOT OUTPUT [APPIMAGE]');
}
const payload = resolve(payloadArg);
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'o8-linux-diagnosis-'));
const clean = text => String(text).replaceAll(process.cwd(), '<work>')
  .replaceAll(profile, '<profile>').replace(/\/home\/[^/\s"']+/g, '<home>');
const save = (name, text) => writeFileSync(join(output, name), clean(text));
const environment = { HOME: profile, PATH: '/usr/bin:/bin', NODE_ENV: 'production',
  DISPLAY: process.env.DISPLAY, APPIMAGE_EXTRACT_AND_RUN: '1',
  LD_LIBRARY_PATH: join(payload, 'usr/lib/o8/lib'),
  LIBGL_ALWAYS_SOFTWARE: '1', O8_NEXT_API_TOKEN: 'diagnostic-endpoint-only' };
for (const name of ['XAUTHORITY', 'XDG_RUNTIME_DIR', 'LANG', 'VK_ICD_FILENAMES', 'VK_DRIVER_FILES']) {
  if (process.env[name]) environment[name] = process.env[name];
}
function command(program, args, env = environment) {
  const result = spawnSync(program, args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, signal: result.signal,
    stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}
function recordCommand(name, program, args, env) {
  const result = command(program, args, env);
  save(`${name}.log`, JSON.stringify({ program, args, status: result.status, signal: result.signal })
    + '\n' + result.stdout + result.stderr);
  return result;
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}
const libraries = files(join(payload, 'usr/lib/o8'));
const missing = [];
for (const file of libraries) {
  const fd = openSync(file, 'r');
  const header = Buffer.alloc(4);
  try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
  if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
  const result = command('ldd', [file]);
  const relative = file.slice(payload.length + 1);
  save(`ldd-${relative.replaceAll('/', '_')}.log`, result.stdout + result.stderr);
  for (const line of (result.stdout + result.stderr).split('\n').filter(line => line.includes('not found'))) {
    missing.push({ binary: relative, dependency: line.trim() });
  }
}
save('missing-libraries.json', JSON.stringify(missing, null, 2));
save('bundled-vulkan-loader.json', JSON.stringify(libraries.filter(file => /^libvulkan\.so/.test(basename(file)))
  .map(file => file.slice(payload.length + 1))));
recordCommand('glibc', 'getconf', ['GNU_LIBC_VERSION']);
recordCommand('packages', 'dpkg-query', ['-W', 'mesa-vulkan-drivers', 'libvulkan1', 'vulkan-tools']);
recordCommand('vulkan-summary', 'vulkaninfo', ['--summary']);
const features = command('vulkaninfo', []);
save('vulkan-required-features.log', (features.stdout + features.stderr).split('\n')
  .filter(line => /apiVersion|deviceName|inlineUniformBlock|maxInlineUniformBlockSize|maxDescriptorSetInlineUniformBlocks|timelineSemaphore|dynamicRendering|VK_EXT_inline_uniform_block|VK_KHR_timeline_semaphore|VK_KHR_descriptor_update_template|VK_KHR_dynamic_rendering/.test(line)).join('\n'));

function snapshot(name) {
  recordCommand(`${name}-windows`, 'xwininfo', ['-root', '-tree']);
  const file = join(output, `${name}.png`);
  const image = command('import', ['-window', 'root', `png:${file}`]);
  if (image.status !== 0) { save(`${name}-capture-error.log`, image.stderr); return null; }
  return Number(command('identify', ['-format', '%k', file]).stdout);
}
async function probe(name, binary, args, env) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => { stderr += error.message; });
  await delay(5_000);
  const earlyColors = snapshot(`${name}-early`);
  await delay(10_000);
  const lateColors = snapshot(`${name}-late`);
  recordCommand(`${name}-xrefresh`, 'xrefresh', ['-none']);
  const refreshedColors = snapshot(`${name}-refreshed`);
  const beforeStop = { exitCode: child.exitCode, signal: child.signalCode };
  child.kill('SIGTERM');
  await delay(500);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  await delay(200);
  save(`${name}-stdout.log`, stdout); save(`${name}-stderr.log`, stderr);
  return { name, ...beforeStop, earlyColors, lateColors, refreshedColors };
}

// Only the direct renderer probe uses this synthetic endpoint. It is not a
// claim that the bundled server started or that a real session connected.
const endpoint = createServer((_request, response) => {
  response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{}');
});
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
const results = [];
try {
  const address = endpoint.address();
  const binary = join(payload, 'usr/lib/o8/o8-next');
  results.push(await probe('direct-renderer', binary, ['--enable-next', '--app-shell',
    '--server', `http://127.0.0.1:${address.port}`, '--shell-state', join(profile, 'direct-shell.json')], environment));
  const noDriver = { ...environment, VK_ICD_FILENAMES: join(profile, 'no-driver.json'), VK_DRIVER_FILES: join(profile, 'no-driver.json') };
  recordCommand('no-driver-vulkan-summary', 'vulkaninfo', ['--summary'], noDriver);
  results.push(await probe('no-driver-renderer', binary, ['--enable-next', '--app-shell',
    '--server', `http://127.0.0.1:${address.port}`, '--shell-state', join(profile, 'no-driver-shell.json')], noDriver));
  if (appimageArg) {
    // Used inside the offline container with no installed Vulkan ICD. Run the
    // real entry point as well, with its own bundled server and private profile.
    const launcher = resolve(appimageArg);
    const env = { ...environment, O8_DATA_DIR: join(profile, 'appimage'), CORTEX_IDE_DATA_DIR: join(profile, 'appimage') };
    delete env.O8_NEXT_API_TOKEN;
    results.push(await probe('real-appimage', launcher, [], env));
    const state = command(launcher, ['serve', 'status'], env);
    try {
      const status = JSON.parse(state.stdout);
      save('real-appimage-server.json', JSON.stringify({ healthy: status.healthy, running: status.running }));
    } catch { save('real-appimage-server.log', state.stderr); }
    recordCommand('real-appimage-stop', launcher, ['serve', 'stop'], env);
  }
  save('receipt.json', JSON.stringify({ missingLibraries: missing, probes: results }, null, 2));
  console.log(JSON.stringify({ missingLibraries: missing, probes: results }));
} finally { endpoint.close(); rmSync(profile, { recursive: true, force: true }); }
