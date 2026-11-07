import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Regression guard: the repos `clone` action must never surface a credential
 * embedded in the clone URL back to the client.
 *
 * cloneRepoToDefaultLocation builds `Clone failed: <last stderr line>` from the
 * child process and POST /api/panel/repos returns that message verbatim. A
 * clone URL supplied by the caller can carry userinfo
 * (`https://user:token@host/...`, or a bare token as the username). Current
 * git/gh redact userinfo before printing, so a live clone cannot be made to
 * leak deterministically — but older git versions and some transport error
 * paths echo the URL verbatim, and the message may also be logged or captured
 * downstream. We therefore simulate the subprocess boundary emitting a
 * credential-bearing stderr line and assert the real error-construction path
 * strips it. The fake token below is not a real credential.
 *
 * This drives the real exported cloneRepoToDefaultLocation (the code that
 * builds the surfaced message); only the external child process is stubbed.
 */

const FAKE_TOKEN = 'ghp_FAKE0TESTONLY0abcDEF0123456789';

// Stub the child-process boundary. cloneRepoToDefaultLocation uses
// `promisify(execFile)`, so the stub carries a promisify.custom that rejects
// with the configured stderr — the shape git/gh produce on a failed clone.
const rejection = vi.hoisted(() => ({ stderr: '' }));
vi.mock('@/lib/providers/child-process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const stub = (() => {
    throw new Error('execFile must be called via promisify in this path');
  }) as unknown as Record<symbol, unknown>;
  Object.defineProperty(stub, custom, {
    value: () => Promise.reject(Object.assign(new Error('clone process failed'), { stderr: rejection.stderr })),
  });
  return { execFile: stub };
});

const REAL_HOME = process.env.HOME;
const tmpHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-clone-redact-')));
process.env.HOME = tmpHome;

const { cloneRepoToDefaultLocation, RepoCloneError } = await import('@/lib/repos/clone');

beforeEach(() => {
  rejection.stderr = '';
});

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

async function cloneFailure(cloneUrl: string, name: string): Promise<string> {
  try {
    await cloneRepoToDefaultLocation(cloneUrl, name);
  } catch (error) {
    expect(error).toBeInstanceOf(RepoCloneError);
    return (error as InstanceType<typeof RepoCloneError>).message;
  }
  throw new Error('expected cloneRepoToDefaultLocation to throw');
}

describe('cloneRepoToDefaultLocation never surfaces clone-URL userinfo', () => {
  it('strips user:token from the git (non-GitHub) failure line', async () => {
    rejection.stderr = `Cloning into 'x'...\nfatal: unable to access 'https://o8user:${FAKE_TOKEN}@git.example.invalid/acme/widgets.git/': Could not resolve host: git.example.invalid`;
    const message = await cloneFailure('https://git.example.invalid/acme/widgets.git', 'widgets');

    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain('o8user:');
    expect(message).not.toContain('@git.example.invalid');
    // The host stays — a redacted URL is still useful for diagnosis.
    expect(message).toContain('https://git.example.invalid/acme/widgets.git');
    expect(message.startsWith('Clone failed:')).toBe(true);
  });

  it('strips a bare token username from the gh (GitHub) failure line', async () => {
    rejection.stderr = `fatal: repository 'https://${FAKE_TOKEN}@github.com/acme/private-repo.git/' not found`;
    const message = await cloneFailure('https://github.com/acme/private-repo.git', 'private-repo');

    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain('@github.com');
    expect(message).toContain('https://github.com/acme/private-repo.git');
  });

  it('only the last stderr line is surfaced, and it is still redacted', async () => {
    rejection.stderr = [
      "Cloning into 'widgets'...",
      'remote: Enumerating objects',
      `fatal: Authentication failed for 'https://ci-bot:${FAKE_TOKEN}@git.example.invalid/acme/widgets.git/'`,
    ].join('\n');
    const message = await cloneFailure('https://git.example.invalid/acme/widgets.git', 'widgets');

    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain('ci-bot:');
    expect(message).toContain('Authentication failed');
  });

  it('strips a password that itself contains @ (split at the last @, not the first)', async () => {
    // A legal password can contain '@'; URL parsers split userinfo at the LAST
    // '@'. A first-@ strip would leak the password tail before the host.
    rejection.stderr = `fatal: unable to access 'https://user:p@ss${FAKE_TOKEN}@git.example.invalid/acme/widgets.git/': denied`;
    const message = await cloneFailure(`https://user:p@ss${FAKE_TOKEN}@git.example.invalid/acme/widgets.git`, 'widgets');

    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain('p@ss');
    expect(message).toContain('git.example.invalid/acme/widgets.git');
  });

  it('strips a token echoed in an scp-form ssh remote (no scheme:// to anchor on)', async () => {
    // A non-GitHub URL takes the plain-git branch; an ssh scp-form remote error
    // echoes `user@host:` which the scheme rule cannot match, so the exact
    // value from the caller URL must be removed.
    rejection.stderr = `${FAKE_TOKEN}@git.example.invalid: Permission denied (publickey).`;
    const message = await cloneFailure(`${FAKE_TOKEN}@git.example.invalid:acme/widgets.git`, 'widgets');

    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).toContain('Permission denied');
  });

  it('does not mangle a bare email or a credential-free URL in the line', async () => {
    rejection.stderr = 'error for ops@example.com: see https://git.example.invalid/acme/widgets.git';
    const message = await cloneFailure('https://git.example.invalid/acme/widgets.git', 'widgets');

    // No scheme://userinfo@ and no caller credentials, so the line is intact.
    expect(message).toBe('Clone failed: error for ops@example.com: see https://git.example.invalid/acme/widgets.git');
  });

  it('never folds a credential into the derived repo name (destination-collision message)', async () => {
    // A path-less authenticated URL: the repo name is derived from the URL. The
    // name must come from the host, not the userinfo, or the token lands in the
    // destination path and the collision error (and on disk). Pre-create the
    // non-git directory the unredacted derivation would target so the collision
    // branch is exercised.
    const unredactedName = `${FAKE_TOKEN}-git.example.invalid`;
    mkdirSync(path.join(tmpHome, 'Developer', unredactedName), { recursive: true });
    const message = await cloneFailure(`https://${FAKE_TOKEN}@git.example.invalid`, '');

    expect(message).not.toContain(FAKE_TOKEN);
  });

  it('leaves a stderr line without userinfo untouched', async () => {
    rejection.stderr = 'fatal: repository not found';
    const message = await cloneFailure('https://git.example.invalid/acme/widgets.git', 'widgets');

    expect(message).toBe('Clone failed: fatal: repository not found');
  });
});
