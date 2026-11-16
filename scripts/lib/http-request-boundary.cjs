'use strict';

const shellOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

function isLoopbackHost(host, port) {
  if (typeof host !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/i.exec(host);
  if (!match || (match[2] && Number(match[2]) > 65535)) return false;
  return port === undefined || match[2] === String(port) || (!match[2] && (port === 80 || port === 443));
}

/** Loopback names and the shell's own origin: the only hosts that can carry loopback trust. */
function isShellHost(host, port) {
  if (isLoopbackHost(host, port)) return true;
  if (typeof host !== 'string') return false;
  const canonical = host.toLowerCase();
  return canonical === 'tauri.localhost' || (port !== undefined
    ? canonical === `tauri.localhost:${port}`
    : /^tauri\.localhost:[1-9][0-9]{0,4}$/.test(canonical) && Number(canonical.split(':')[1]) <= 65535);
}

// This file is also bundled for the browser, so it must not load Node modules.
// Server entry points hand in the rule that also reads the saved setting; without
// one, only the launch environment can open the network host rule.
let lanAccessEnabled = (env = process.env) =>
  ['1', 'true', 'yes', 'on'].includes(String(env.O8_LAN_ACCESS ?? '').trim().toLowerCase());
function useLanAccess(rule) { lanAccessEnabled = rule; }

/**
 * A phone on the same network addresses this machine by its IPv4 address. A
 * numeric address cannot be re-pointed by DNS, so it is not the rebinding case
 * the name check exists for. It never carries loopback trust.
 */
function isIpv4LiteralHost(host, port) {
  if (typeof host !== 'string') return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::([1-9][0-9]{0,4}))?$/.exec(host);
  if (!match || match.slice(1, 5).some(part => Number(part) > 255 || (part.length > 1 && part[0] === '0'))) return false;
  if (match[5] && Number(match[5]) > 65535) return false;
  return port === undefined || match[5] === String(port) || (!match[5] && (port === 80 || port === 443));
}

function isAllowedLocalHost(host, port, env = process.env) {
  return isShellHost(host, port) || (lanAccessEnabled(env) && isIpv4LiteralHost(host, port));
}

function requestTargetAllowed(target, port) {
  if (typeof target !== 'string') return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) return true;
  // Validate the raw authority: URL parsing would normalize disallowed aliases.
  const absolute = /^https?:\/\/([^/?#]*)(?:[/?]|$)/i.exec(target);
  return !!absolute && !target.includes('#') && isAllowedLocalHost(absolute[1], port);
}

function browserWriteAllowed(method, get, protocol = 'http:') {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return true;
  const origin = get('origin');
  if (origin === null) {
    // Native HTTP libraries can send sec-fetch-mode without browser context.
    return get('sec-fetch-site') === null && get('sec-fetch-dest') === null
      && !/^Mozilla\//i.test(get('user-agent') || '');
  }
  if (shellOrigins.has(origin)) return true;
  try {
    const host = get('host');
    if (!isAllowedLocalHost(host) || !['http:', 'https:'].includes(protocol)) return false;
    const expected = new URL(`${protocol}//${host}`).origin;
    return origin === new URL(origin).origin && origin === expected;
  } catch { return false; }
}

exports.isLoopbackHost = isLoopbackHost;
exports.useLanAccess = useLanAccess;
exports.isShellHost = isShellHost;
exports.isAllowedLocalHost = isAllowedLocalHost;
exports.requestTargetAllowed = requestTargetAllowed;
exports.browserWriteAllowed = browserWriteAllowed;
