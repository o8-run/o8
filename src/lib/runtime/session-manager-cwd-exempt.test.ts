import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import { unreadableCwdReason, type ProcExemptProbe } from './process-open-files-snapshot';

// #5423: #5403's denied-cwd refusal fires on the runner's own `systemd --user`
// and its `(sd-pam)` child, whose cwd readlink is blocked by ptrace_scope=1
// (they are PPid 1, not our descendants) even though they are same-uid and
// dumpable, so every worktree cleanup refuses. A same-uid session manager that
// provably cannot hold the worktree must not block cleanup, while every other
// denied-cwd process still does.

const onLinux = process.platform === 'linux';
const uid = userInfo().uid;
const login = userInfo().username;

/** A denied-cwd row as parseOpenFileSnapshot emits it (file blanked, owner=login). */
function deniedRow(pid: number, owner: string | undefined = login) {
  return { pid, descriptor: 'cwd', commandName: 'process', file: '', unreadable: true as const,
    ...(owner === undefined ? {} : { owner }) };
}

/** Simulates the GitHub Ubuntu runner's /proc for the session-manager lineage. */
const runnerProbe: ProcExemptProbe = {
  status(pid) {
    // 1293 = `systemd --user` (PPid 1); 1307 = its `(sd-pam)` child.
    if (pid === 1293) return { uid, name: 'systemd', ppid: 1 };
    if (pid === 1307) return { uid, name: '(sd-pam)', ppid: 1293 };
    // 5000 = an ordinary same-uid worker-like process; 6000 = a `systemd` spoof
    // that is NOT PPid 1; 7000 = a non-dumpable (root-owned /proc) same-uid proc.
    if (pid === 5000) return { uid, name: 'node', ppid: 4000 };
    if (pid === 6000) return { uid, name: 'systemd', ppid: 4000 };
    if (pid === 7000) return { uid, name: 'worker', ppid: 4000 };
    return null;
  },
  cwdLinkUid(pid) {
    // Same-uid, dumpable: the cwd link is owned by our uid but readlink is denied.
    if ([1293, 1307, 5000, 6000].includes(pid)) return uid;
    // Non-dumpable: /proc is root-owned.
    if (pid === 7000) return 0;
    return null;
  },
};

describe('unreadableCwdReason session-manager exemption (#5423)', () => {
  it('still refuses a denied-cwd row with an unknown owner (no L field)', () => {
    // lsof emitted no owner, so we cannot attest it even if its pid looks like a manager.
    const noOwner = { pid: 1293, descriptor: 'cwd', commandName: 'process', file: '', unreadable: true as const };
    expect(unreadableCwdReason([noOwner], runnerProbe)).toMatch(/pid 1293/);
  });

  it('still refuses an ordinary same-uid denied-cwd process', () => {
    expect(unreadableCwdReason([deniedRow(5000)], runnerProbe)).toMatch(/pid 5000/);
  });

  it('still refuses a `systemd`-named process that is not PPid 1 (lineage, not name)', () => {
    expect(unreadableCwdReason([deniedRow(6000)], runnerProbe)).toMatch(/pid 6000/);
  });

  it('returns null when there are no denied-cwd rows', () => {
    expect(unreadableCwdReason([{ pid: 10, descriptor: 'cwd', commandName: 'x', file: '/tmp' }], runnerProbe)).toBeNull();
  });

  it.skipIf(!onLinux)('exempts the uid\'s own `systemd --user` (PPid 1)', () => {
    expect(unreadableCwdReason([deniedRow(1293)], runnerProbe)).toBeNull();
  });

  it.skipIf(!onLinux)('exempts the session manager\'s `(sd-pam)` child', () => {
    expect(unreadableCwdReason([deniedRow(1307)], runnerProbe)).toBeNull();
  });

  it.skipIf(!onLinux)('exempts a non-dumpable (root-owned /proc) same-uid process', () => {
    expect(unreadableCwdReason([deniedRow(7000)], runnerProbe)).toBeNull();
  });

  it.skipIf(!onLinux)('still refuses the manager plus a real holder in the same batch', () => {
    expect(unreadableCwdReason([deniedRow(1293), deniedRow(5000)], runnerProbe)).toMatch(/pid 5000/);
  });
});
