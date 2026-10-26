'use strict';

const shellOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

function isLoopbackHost(host, port) {
  if (typeof host !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/i.exec(host);
  if (!match || (match[2] && Number(match[2]) > 65535)) return false;
  return port === undefined || match[2] === String(port) || (!match[2] && (port === 80 || port === 443));
}

function isAllowedLocalHost(host, port) {
  if (isLoopbackHost(host, port)) return true;
  if (typeof host !== 'string') return false;
  const canonical = host.toLowerCase();
  return canonical === 'tauri.localhost' || (port !== undefined
    ? canonical === `tauri.localhost:${port}`
    : /^tauri\.localhost:[1-9][0-9]{0,4}$/.test(canonical) && Number(canonical.split(':')[1]) <= 65535);
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
exports.isAllowedLocalHost = isAllowedLocalHost;
exports.browserWriteAllowed = browserWriteAllowed;
