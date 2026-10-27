/** Read-only producer observation shared by ship preflight and prebuild. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// Path spelling is not directory identity on case-insensitive volumes or mount
// aliases. Follow links and compare every ancestor with the workspace inode.
function inside(directory, workspaceIdentity, { allowMissing = false } = {}) {
  let current = directory;
  const root = path.parse(directory).root;
  while (current.length > root.length && current.endsWith(path.sep)) current = current.slice(0, -1);
  for (;;) {
    let identity;
    try {
      identity = statSync(current, { bigint: true });
      if (!identity.isDirectory()) throw new Error('producer working-directory ancestor is not a directory');
    }
    catch (error) {
      if (!allowMissing || error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      // A dangling link can point into the release workspace. Its unresolved
      // target is unknown; never reconstruct it as an ordinary missing name.
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('unresolved producer working-directory alias');
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
    }
    if (identity && identity.dev === workspaceIdentity.dev && identity.ino === workspaceIdentity.ino) return true;
    // A known symlink can target a workspace descendant. Visit that target's
    // ancestors too; case and mount aliases still use their directory identity.
    const resolved = identity ? realpathSync(current) : current;
    const parent = path.dirname(resolved);
    if (parent === resolved) return false;
    current = parent;
  }
}

export function assertNoProducer(workspace, { run = execFileSync } = {}) {
  const workspaceIdentity = statSync(workspace, { bigint: true });
  if (!workspaceIdentity.isDirectory()) throw new Error('release workspace is not a directory');
  const snapshot = (command, args, maxBuffer = 4 * 1024 ** 2) => run(command, args,
    { encoding: 'utf8', timeout: 5_000, maxBuffer });
  // Select the executable position or process title, never prompt text. This
  // observation grants no authority to signal a process or dispose of output.
  const candidates = snapshot('ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    const producer = match && (
      /^(?:(?:\S*\/)?(?:node|nodejs|bun)\s+)?(?:\S*\/)?next(?:\/dist\/bin\/next)?\s+(?:build|dev|start)(?:\s|$)/.test(match[2])
      || /^next-(?:build|server)(?:\s|\(|$)/.test(match[2])
    );
    return producer ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
  for (const { pid, command } of candidates) {
    if (pid === process.pid) continue;
    let reported;
    let directory;
    let cwd;
    const diagnostic = () => `pid=${pid} command=${JSON.stringify(command)} cwd=${JSON.stringify(reported ?? '<unavailable>')}`;
    try {
      if (process.platform === 'linux') {
        reported = readlinkSync(`/proc/${pid}/cwd`);
        // The kernel annotates the link target of an unlinked working directory.
        directory = reported.replace(/ \(deleted\)$/, '');
      } else if (process.platform === 'darwin') {
        const names = snapshot('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], 64 * 1024)
          .split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
        reported = names.length ? names.join(' | ') : undefined;
        if (names.length !== 1) throw new Error('ambiguous producer working directory');
        directory = names[0];
      } else throw new Error('producer working-directory probe is unavailable');
      if (!path.isAbsolute(directory)) throw new Error('producer working directory is not absolute');
      // Resolve the proc link itself on Linux, so a literal " (deleted)" in an
      // existing directory name is not mistaken for the kernel's annotation.
      cwd = realpathSync(process.platform === 'linux' ? `/proc/${pid}/cwd` : directory);
    } catch (error) {
      // A vanished candidate is harmless. Unknown live candidates still refuse.
      try { if (!snapshot('ps', ['-p', String(pid), '-o', 'pid=']).trim()) continue; }
      catch (probeError) { if (probeError.status === 1 && !probeError.stdout?.trim()) continue; }
      if (error.code === 'ENOENT' && directory && path.isAbsolute(directory)) {
        let contained;
        try { contained = inside(directory, workspaceIdentity, { allowMissing: true }); } catch { /* fail closed */ }
        if (contained === false) {
          console.warn(`[producer-check] warning: working directory no longer exists outside release workspace; ${diagnostic()}`);
          continue;
        }
      }
      throw new Error(`possible live producer has an unknown working directory; ${diagnostic()}`);
    }
    let contained;
    try { contained = inside(cwd, workspaceIdentity); }
    catch { throw new Error(`possible live producer has an unknown working directory; ${diagnostic()}`); }
    if (contained) {
      throw new Error(`workspace has a live generated-output producer; ${diagnostic()}`);
    }
  }
}
