import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
function rustFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? rustFiles(path) : entry.name.endsWith('.rs') ? [path] : [];
  });
}

describe('native shutdown registration boundary for detached packet workers', () => {
  it('registers only the bundled server children and their supervisor replacements', () => {
    const shell = read('src-tauri/src/lib.rs');
    const registrations = rustFiles('src-tauri/src').filter(file => (
      /sidecar_lifecycle::register_child\s*\(/.test(read(file))
    ));
    expect(registrations).toEqual(['src-tauri/src/lib.rs']);
    const supervisor = shell.slice(shell.indexOf('fn supervise_next_sidecar<'), shell.indexOf('struct BundledNextSpawn'));
    expect(supervisor).toContain('let pid = child.id();');
    expect(supervisor).toContain('sidecar_lifecycle::register_child(pid)');
    expect(supervisor).toContain('sidecar_lifecycle::register_child,');
    expect(shell.match(/let supervisor = supervise_next_sidecar\(child,/g)).toHaveLength(2);
    expect(shell).toContain('let child = spawn.spawn(child_log.as_ref())?;');
    expect(shell).toContain('let next_pid = next.id();');
    expect(shell).toContain('register_child(next_pid)');
    for (const name of ['BundledNextSpawn', 'BundledWsSpawn']) {
      const start = shell.indexOf(`impl ${name}`);
      const body = shell.slice(start, shell.indexOf('\nfn spawn_and_supervise_', start));
      expect(body).toContain('Command::new(&self.node_bin)');
      expect(body).toContain('.arg(&self.server_js)');
    }
  });

  it('quit and updater cleanup signal positive server PIDs, never detached worker groups', () => {
    const lifecycle = read('src-tauri/src/sidecar_lifecycle.rs');
    const unix = lifecycle.slice(lifecycle.indexOf('fn kill_tracked_children_unix('), lifecycle.indexOf('fn kill_tracked_children_windows('));
    expect(unix).toContain('.args(["-TERM", &pid.to_string()])');
    expect(unix).toContain('.args(["-KILL", &pid.to_string()])');
    expect(unix).not.toMatch(/killpg|format!\("-|\.arg\("--"\)/);
    const shell = read('src-tauri/src/lib.rs');
    expect(shell.slice(shell.lastIndexOf('RunEvent::ExitRequested'))).toContain('sidecar_lifecycle::kill_tracked_children()');
    expect(shell).toMatch(/api_port, sidecar_lifecycle::kill_tracked_children/);
    expect(read('src-tauri/src/restart_job_drain.rs')).toContain('cleanup();');
    const worker = read('src/lib/runtimes/shared/owned-session/run-controller.ts');
    const launch = read('src/lib/runtimes/shared/owned-session/credential-spawn.ts');
    expect(worker).toContain('const child = spawnCredentialCheckedChild(launchInput);');
    expect(launch).toContain('detached: true,');
    expect(launch).toContain("stdio: [input.stdinFd ?? 'ignore', input.stdoutFd, input.stderrFd]");
    expect(launch).toContain('workerOwnedStdinInvocation(launch, input.stdinBytes ?? fstatSync(input.stdinFd).size)');
    expect(launch).not.toContain('child.stdin');
    expect(worker).toContain('child.unref()');
    expect(`${worker}\n${launch}`).not.toContain('register_child');
  });

  it('requires detached identity only for the detached preparation path, preserving bridge opt-out', () => {
    const worker = read('src/lib/runtimes/shared/owned-session/run-controller.ts');
    expect(worker).toMatch(/processIdentityRequired: crashSurvivableWorkersEnabled\(\) && Boolean\(session.packetId\)/);
  });
});
