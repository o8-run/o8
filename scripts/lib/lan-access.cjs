'use strict';
const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

// File format: exactly "on\n" or "off\n". Any environment value takes precedence.
function dataDir(env = process.env) {
  return env.O8_DATA_DIR || env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
}
function savedLanAccess(env = process.env) {
  try { return readFileSync(join(dataDir(env), 'phone-network'), 'utf8') === 'on\n'; }
  catch { return false; }
}
function lanAccessEnabled(env = process.env) {
  if (env.O8_LAN_ACCESS !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(env.O8_LAN_ACCESS.trim().toLowerCase());
  }
  return savedLanAccess(env);
}
exports.dataDir = dataDir;
exports.savedLanAccess = savedLanAccess;
exports.lanAccessEnabled = lanAccessEnabled;
