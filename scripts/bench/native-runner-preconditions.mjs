// Hosted-runner setup for the isolated measurement identifiers only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function prepareNativeRunner(bundleId, stageRoot, { managePrivacy = true } = {}) {
  assert.equal(process.platform, 'darwin');
  if (managePrivacy) assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert(/^ai\.o8\.desktop\.(launchbench|memorybench)$/.test(bundleId));
  const source = path.join(stageRoot, 'activate.swift');
  const executable = path.join(stageRoot, 'activate');
  fs.writeFileSync(source, `import AppKit
import Darwin
guard CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == CommandLine.arguments[2] else { exit(78) }
exit(app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) ? 0 : 1)
`);
  execFileSync('/usr/bin/swiftc', [source, '-o', executable], { stdio: 'pipe' });
  // Local disposable accounts keep their manually configured permission state.
  if (!managePrivacy) return { executable, services: [], privacySetupError: null, restore() {} };
  const file = path.join(os.homedir(), 'Library/Application Support/com.apple.TCC/TCC.db');
  let db, privacySetupError;
  const previous = [];
  const services = ['Microphone', 'SpeechRecognition', 'ListenEvent', 'Accessibility', 'AppleEvents'];
  try {
    assert(fs.existsSync(file), 'The hosted runner privacy database is unavailable');
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    const schema = db.prepare('PRAGMA table_info(access)').all();
    const known = { service: '', client: bundleId, client_type: 0, auth_value: 0, auth_reason: 4, auth_version: 1,
      csreq: null, policy_id: null, indirect_object_identifier_type: 0, indirect_object_identifier: 'UNUSED',
      indirect_object_code_identity: null, flags: 0, last_modified: Math.floor(Date.now() / 1000),
      pid: 0, pid_version: 0, boot_uuid: 'UNUSED', last_reminded: Math.floor(Date.now() / 1000) };
    for (const column of schema) {
      assert(/^[a-z_]+$/.test(column.name), 'Unexpected privacy database column');
      assert(!column.notnull || column.dflt_value !== null || Object.hasOwn(known, column.name),
        `Missing required privacy column: ${column.name}`);
    }
    const columns = schema.map(row => row.name).filter(name => Object.hasOwn(known, name));
    assert(columns.includes('auth_value'), 'Unsupported privacy database schema');
    const insert = db.prepare(`INSERT OR REPLACE INTO access (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    const select = db.prepare('SELECT * FROM access WHERE service = ? AND client = ? AND client_type = 0 AND indirect_object_identifier = ?');
    db.exec('BEGIN IMMEDIATE');
    for (const service of services) {
      const row = { ...known, service: `kTCCService${service}`,
        indirect_object_identifier: service === 'AppleEvents' ? bundleId : 'UNUSED' };
      previous.push({ service: row.service, target: row.indirect_object_identifier,
        row: select.get(row.service, bundleId, row.indirect_object_identifier) });
      insert.run(...columns.map(name => row[name]));
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch {}
    privacySetupError = error.code ?? 'privacy_setup_unavailable';
  } finally { db?.close(); }
  return { executable, services: privacySetupError ? [] : services, privacySetupError, restore() {
    if (privacySetupError) return;
    const restore = new DatabaseSync(file);
    try {
      restore.exec('PRAGMA busy_timeout = 5000');
      for (const saved of previous) {
        restore.prepare('DELETE FROM access WHERE service = ? AND client = ? AND client_type = 0 AND indirect_object_identifier = ?')
          .run(saved.service, bundleId, saved.target);
        if (saved.row) {
          const columns = Object.keys(saved.row);
          restore.prepare(`INSERT INTO access (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
            .run(...columns.map(name => saved.row[name]));
        }
      }
    } finally { restore.close(); }
  } };
}
