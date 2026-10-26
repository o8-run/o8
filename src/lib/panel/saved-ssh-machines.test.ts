import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { listRemoteTerminalSessions, listSavedSshMachines, remoteControlCommand, SavedMachineError } from './saved-ssh-machines';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'o8-machines-'));
  directories.push(dir);
  const machine = {
    id: '12345678-1234-1234-1234-123456789abc', label: 'Studio', target: 'fixture@localhost',
    port: 2200, remoteCli: 'o8', sshConfig: null, enabled: true,
  };
  writeFileSync(join(dir, 'ssh-machines.json'), JSON.stringify({ schema: 'o8/cli/machines/v1', machines: [machine] }));
  return { dir, machine };
}

it('reads only the validated saved catalog and refuses malformed machine targets', () => {
  const { dir, machine } = fixture();
  expect(listSavedSshMachines(dir)).toEqual([machine]);
  writeFileSync(join(dir, 'ssh-machines.json'), JSON.stringify({ schema: 'o8/cli/machines/v1', machines: [{ ...machine, target: '-ProxyCommand=evil' }] }));
  expect(() => listSavedSshMachines(dir)).toThrow(SavedMachineError);
});

it('checks live inventory through batch-mode SSH and keeps host-key errors visible', async () => {
  const { dir, machine } = fixture();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const argsFile = join(dir, 'ssh-args');
  const failureFile = join(dir, 'ssh-fail');
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nif [ -f '${failureFile}' ]; then echo 'Host key verification failed.' >&2; exit 255; fi\nprintf '%s\\n' '{"schema":"o8/cli/terminal.list/v1","sessions":[{"id":"dash-1","cols":80,"rows":24}]}'\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  expect(await listRemoteTerminalSessions(machine)).toEqual([{ id: 'dash-1', cols: 80, rows: 24 }]);
  const args = readFileSync(argsFile, 'utf8');
  expect(args).toContain('BatchMode=yes');
  expect(args).toContain('StrictHostKeyChecking=yes');
  expect(args).toContain('fixture@localhost');
  expect(args).toContain("'o8' 'terminal' 'list'");
  // The process boundary intentionally rejects arbitrary ambient fixture flags.
  writeFileSync(failureFile, 'fail');
  await expect(listRemoteTerminalSessions(machine)).rejects.toMatchObject({ code: 'machine_unreachable', message: 'Host key verification failed.' });
});

it('builds a bound control command from the current CLI bundle', () => {
  const { dir, machine } = fixture();
  const cliDir = join(dir, 'cli', 'dist');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, 'o8.mjs'), '');
  const command = remoteControlCommand(machine.id, "session'quoted", dir);
  expect(command).toContain("--human terminal control 'session'\\''quoted'");
  expect(command).toContain(`--machine '${machine.id}'`);
  expect(command.startsWith('exec ')).toBe(true);
});
