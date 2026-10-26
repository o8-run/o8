#!/usr/bin/env node
/**
 * Tauri prebuild — splits the build into:
 *   out/frontend/  → Tauri frontendDist (just the loader HTML)
 *   out/server/    → Tauri bundle resource (Next.js server + Node binary)
 */
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, chmodSync } from 'fs';
import { execFileSync as runFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { prepareNativeBundle } from './native-bundle.mjs';
import { exportTauriSafetyHookResources } from './tauri-hook-resources.mjs';
import { resolveReleaseConfig } from './lib/release-config.mjs';
import { canonicalizeServerOnlyStubEnv } from './run-lib.mjs';
import { assertTauriExportInputsSafe } from './lib/tauri-export-safety.mjs';
import { prunePackagedBuildInputs } from './lib/packaged-build-inputs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'out');
const frontend = join(out, 'frontend');
const server = join(out, 'server');
const standalone = join(root, '.next', 'standalone');
const staticDir = join(root, '.next', 'static');
const pub = join(root, 'public');
const loaderVerifyPath = join(root, 'scripts', 'loader-verify.mjs');
const nativeAddonRuntimePath = join(root, 'scripts', 'native-addon-runtime.cjs');

// Real version for the loader's corner stamp — the template used to carry a
// stale hardcoded fallback (v0.1.16 forever) because __O8_VERSION__ is not
// injected at loader time.
let loaderAppVersion = 'dev';
try {
  loaderAppVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || 'dev';
} catch { /* keep 'dev' */ }

// Verify standalone build
if (!existsSync(standalone)) {
  console.error('❌ No standalone build at .next/standalone — run next build first');
  process.exit(1);
}
try {
  assertTauriExportInputsSafe(standalone);
} catch (error) {
  console.error(`❌ Unsafe Tauri export input: ${error.message}`);
  process.exit(1);
}

// Clean previous build only after every source path is known to be isolated.
// A linked standalone node_modules can make out/server/node_modules resolve
// back into the checkout; the native-module replacement below must never
// delete the source package through that alias.
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(frontend, { recursive: true });
mkdirSync(server, { recursive: true });

// Managed worktree hook settings reference immutable files from the running
// o8 installation. Keep those programs beside the packaged server so the
// Next sidecar can resolve them from its resource-root cwd.
exportTauriSafetyHookResources(root, server);

// ── Frontend (loader HTML for Tauri webview) ──
//
// The loader probes the sidecar identity endpoint because any HTTP response on
// a port is not proof that it belongs to this o8 launch. It reads
// `window.__O8_PORT_HINT__` first (injected by Rust's webview initialization
// script), then falls back to the production API block.
const loaderVerifySource = readFileSync(loaderVerifyPath, 'utf-8')
  .replace(/export\s*\{\s*verifyIdentityResponse\s*\};?\s*$/m, '');
const loaderHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>o8</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      /* Glass, not a black slab (Q 2026-07-14): the Tauri window is
         transparent with the vibrancy material applied by the Rust shell, so
         a translucent tint here reads as the SAME dark glass the app chrome
         uses (mirrors DARK_GLASS --t-bg-gradient). On OS versions where the
         boot-time material apply silently fails, the tint alone still gives
         a legible dark veil instead of raw desktop. */
      background: linear-gradient(180deg, rgba(32, 36, 42, 0.62) 0%, rgba(18, 20, 24, 0.58) 100%);
      color: #f4f4f5;
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
      color-scheme: only dark;
    }
    .mono { font-family: "iA Writer Mono", "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace; }
    #ascii { position: fixed; inset: 0; display: block; }
    .bootbar {
      position: fixed; bottom: 0; left: 0; right: 0;
      display: flex; justify-content: space-between; align-items: center;
      padding: 18px 26px;
      font-size: 10.5px; letter-spacing: 0.05em;
      color: rgba(244, 244, 245, 0.34);
      pointer-events: none;
    }
    .bootbar .left { display: flex; align-items: center; gap: 10px; }
    .bootbar .brand { color: rgba(244, 244, 245, 0.74); font-weight: 500; letter-spacing: -0.01em; }
    .bootbar .dot-row { display: inline-flex; gap: 3px; }
    .bootbar .dot-row span {
      width: 3px; height: 3px; border-radius: 50%;
      background: rgba(244, 244, 245, 0.5); opacity: 0.3;
      animation: step 1.4s ease-in-out infinite;
    }
    .bootbar .dot-row span:nth-child(2) { animation-delay: 0.2s; }
    .bootbar .dot-row span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes step { 0%, 100% { opacity: 0.25; } 40% { opacity: 0.9; } }
  </style>
  <script>
    ${loaderVerifySource}

    const HINT = typeof window.__O8_PORT_HINT__ === 'number' ? window.__O8_PORT_HINT__ : null;
    const EXPECTED_BOOT_ID = typeof window.__O8_EXPECTED_BOOT_ID__ === 'string' ? window.__O8_EXPECTED_BOOT_ID__ : '';
    const PROBE_RANGE = [];
    for (let p = 47100; p <= 47104; p++) PROBE_RANGE.push(p);
    const CANDIDATES = HINT ? [HINT, ...PROBE_RANGE.filter(p => p !== HINT)] : PROBE_RANGE;

    let attempts = 0;

    // Steady boot line — no rotating stage text, no ticking clock (Q 2026-07-14:
    // "it should just stay the o8 loading, it shouldn't blink"). The ascii wave
    // + pulsing dots carry the alive signal; the only text change allowed is
    // the failure message in tick()'s deadline branch.
    (function stampOnce() {
      const el = document.getElementById('stamp');
      // Baked at export time; only override if the runtime injected a version.
      if (el && window.__O8_VERSION__) el.textContent = 'v' + window.__O8_VERSION__;
    })();

    async function probe(port) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/setup/identity', {
          method: 'GET',
          cache: 'no-store',
        });
        if (!response.ok) return false;
        const identity = await response.json();
        if (!verifyIdentityResponse(identity, EXPECTED_BOOT_ID)) return false;
        window.location.href = 'http://127.0.0.1:' + port + '/dashboard';
        return true;
      } catch { return false; }
    }

    // Poll cadence: ramp tight -> relaxed instead of a flat 500ms grid.
    // A probe against a port nothing is listening on fails instantly
    // (ECONNREFUSED), so the early attempts are nearly free — and the moment the
    // sidecar binds we want to SEE it, not sit dark waiting out the rest of a
    // 500ms tick. Same ~15s ceiling as the old 30 x 500ms.
    const BACKOFF_MS = [25, 25, 50, 50, 75, 100, 150, 200, 250, 350, 500];
    const DEADLINE_MS = 15000;
    const startedAt = Date.now();

    async function tick() {
      for (let i = 0; i < CANDIDATES.length; i++) {
        const port = CANDIDATES[i];
        if (await probe(port)) return;
      }
      if (Date.now() - startedAt < DEADLINE_MS) {
        const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
        attempts++;
        setTimeout(tick, delay);
      } else {
        // Deadline passed: surface the hint but NEVER stop probing. A cold
        // Windows first boot spends 25s+ in node preflight alone before the
        // server even spawns — a terminal give-up here turns a slow boot into
        // a permanent false "failed" screen (#1673 VM smoke).
        const fail = document.getElementById('stage');
        if (fail && !fail.dataset.failed) {
          fail.dataset.failed = '1';
          fail.innerHTML = '<span style="color:#FF5A1F">still waiting for the server — if this never resolves, install node 22+ at <span style="color:#111">nodejs.org</span></span>';
        }
        setTimeout(tick, 1000);
      }
    }
    // Probe immediately. The window now paints before the sidecar is spawned, so
    // a 500ms head start is pure dead time on the critical path.
    tick();
  </script>
</head>
<body>
  <canvas id="ascii"></canvas>
  <div class="bootbar mono">
    <span class="left">
      <span class="brand">o8</span>
      <span id="stage">starting</span>
      <span class="dot-row"><span></span><span></span><span></span></span>
    </span>
    <span id="stamp">v${loaderAppVersion}</span>
  </div>
  <script>
    (function () {
      var cv = document.getElementById('ascii');
      var ctx = cv.getContext('2d');
      var CFG = { text: 'o8', cell: 6, scale: 0.4, color: '#ffffff', speed: 1.0, baseLevel: 0.5, waveBoost: 0.85, contrast: 1.2, ripple: 33 / 50, radiusFrac: 0.04 };
      var RAMP = ' .:-=+*#%@';
      var dpr = 1, W = 0, H = 0, cols = 0, rows = 0, lum = null;
      var cx = -1, cy = -1;
      var off = document.createElement('canvas');
      function build() {
        W = window.innerWidth; H = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 3);
        cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
        cv.style.width = W + 'px'; cv.style.height = H + 'px';
        cols = Math.max(8, Math.floor(W / CFG.cell));
        rows = Math.max(8, Math.floor(H / CFG.cell));
        lum = new Float32Array(cols * rows);
        off.width = cols; off.height = rows;
        var o = off.getContext('2d', { willReadFrequently: true });
        o.fillStyle = '#000'; o.fillRect(0, 0, cols, rows);
        o.fillStyle = '#fff'; o.textBaseline = 'middle'; o.textAlign = 'center';
        var size = rows * CFG.scale;
        function font(s) { return '700 ' + s + 'px ui-sans-serif, system-ui, -apple-system, sans-serif'; }
        o.font = font(size);
        var w = o.measureText(CFG.text).width;
        var maxW = cols * 0.86, maxH = rows * 0.86;
        if (w > maxW) size = size * (maxW / w);
        if (size > maxH) size = maxH;
        o.font = font(size);
        o.fillText(CFG.text, cols / 2, rows / 2);
        var d = o.getImageData(0, 0, cols, rows).data;
        for (var k = 0; k < cols * rows; k++) {
          var a = d[4 * k + 3] / 255;
          lum[k] = ((0.299 * d[4 * k] + 0.587 * d[4 * k + 1] + 0.114 * d[4 * k + 2]) / 255) * a;
        }
      }
      build();
      window.addEventListener('resize', build);
      window.addEventListener('pointermove', function (e) { cx = e.clientX / CFG.cell; cy = e.clientY / CFG.cell; });
      window.addEventListener('pointerleave', function () { cx = -1; cy = -1; });
      var last = RAMP.length - 1;
      var start = null;
      function frame(ts) {
        if (start === null) start = ts;
        var t = (ts - start) / 1000;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Transparent canvas — the body's glass tint (and the window vibrancy
        // beneath it) shows through between the glyphs.
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = CFG.color;
        ctx.font = CFG.cell + 'px ui-monospace, Menlo, monospace';
        ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        var span = cols + rows * 0.4;
        var edge = ((t * CFG.speed * 0.25) % 1.4) * span;
        var bw = cols * 0.1, bw2 = 2 * bw * bw;
        var rad = CFG.radiusFrac * Math.min(cols, rows), rad2 = 2 * rad * rad;
        var inside = cx >= 0;
        for (var j = 0; j < rows; j++) {
          var y = j * CFG.cell, rowOff = j * cols;
          for (var i = 0; i < cols; i++) {
            var base = lum[rowOff + i];
            if (base <= 0.015) continue;
            var dist = i + j * 0.4 - edge;
            var crest = Math.exp(-(dist * dist) / bw2);
            var val = base * (CFG.baseLevel + crest * CFG.waveBoost);
            if (inside) {
              var dx = i - cx, dy = j - cy, d2 = dx * dx + dy * dy;
              if (d2 < rad2 * 3) { var dd = Math.sqrt(d2); val = val + base * CFG.ripple * Math.exp(-d2 / rad2) * Math.sin(dd * 0.7 - t * 7); }
            }
            if (val <= 0.02) continue;
            if (val > 1) val = 1;
            var idx = Math.round(Math.pow(val, CFG.contrast) * last);
            if (idx <= 0) continue;
            var ch = RAMP.charAt(idx);
            if (ch === ' ') continue;
            ctx.fillText(ch, i * CFG.cell, y);
          }
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    })();
  </script>
</body>
</html>`;
writeFileSync(join(frontend, 'index.html'), loaderHtml);
console.log('📦 Created frontend loader (port-probing)');

// ── Release config: bake the device-flow GitHub OAuth client id (#1338) ──
// The client id is PUBLIC (not a secret), so embedding it in the signed build
// is correct — it's what lets a fresh install render the "Connect GitHub"
// device-flow CTA (deviceFlowEnabled in /api/panel/github-status keys off
// process.env.GITHUB_OAUTH_CLIENT_ID, which was never present in packaged
// builds). Source priority: build env var wins, else o8.release.json at the
// repo root (gitignored, deployment-specific — see config/o8.release.example.json).
// Absent → nothing is stamped and the packaged build behaves exactly as today.
const releaseConfig = resolveReleaseConfig(root);

// Stanza spliced into the server.js wrapper (same process as server-impl.js, so
// setting process.env here is visible to the Next route handlers). The `if
// (!process.env…)` guard means a real env var — dev, operator override — still
// wins over the baked value.
const RELEASE_ENV_STANZA = releaseConfig.githubOAuthClientId
  ? `\n// Device-flow public client id, baked at release build (issue #1338).\n` +
    `if (!process.env.GITHUB_OAUTH_CLIENT_ID) process.env.GITHUB_OAUTH_CLIENT_ID = ${JSON.stringify(releaseConfig.githubOAuthClientId)};\n`
  : '';
if (releaseConfig.githubOAuthClientId) {
  console.log(`📦 Baking GITHUB_OAUTH_CLIENT_ID into server.js wrapper (device flow enabled)`);
} else {
  console.log('📦 No GITHUB_OAUTH_CLIENT_ID configured — device flow stays disabled in this build');
}

// Bake the Sentry DSN so the Next server process (and, via inheritance, any
// child it spawns) inits @sentry/node. The `if (!process.env…)` guard means the
// Rust sidecar's O8_SENTRY_DSN (which it also passes to ws-server) wins when
// present. Absent → the whole telemetry stack stays dormant.
const SENTRY_ENV_STANZA = releaseConfig.sentryDsn
  ? `\n// Sentry crash/error reporting DSN, baked at release build (telemetry ruling).\n` +
    `if (!process.env.O8_SENTRY_DSN) process.env.O8_SENTRY_DSN = ${JSON.stringify(releaseConfig.sentryDsn)};\n`
  : '';
if (releaseConfig.sentryDsn) {
  console.log('📦 Baking O8_SENTRY_DSN into server.js wrapper (Sentry enabled)');
} else {
  console.log('📦 No sentryDsn configured — Sentry stays dormant in this build');
}

// Bake the app version so both the boot crash guard below AND the server's
// resolveAppVersion() (src/lib/telemetry/crash-store.ts) stamp the real version
// even when cwd's package.json is the minimal Next standalone one.
let bakedAppVersion = 'unknown';
try {
  bakedAppVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || 'unknown';
} catch { /* keep 'unknown' */ }
const APP_VERSION_STANZA =
  `\nif (!process.env.O8_APP_VERSION) process.env.O8_APP_VERSION = ${JSON.stringify(bakedAppVersion)};\n`;

let bakedBuildGitSha = 'unknown';
try {
  bakedBuildGitSha = runFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim() || 'unknown';
} catch { /* keep 'unknown' */ }
const BUILD_GIT_SHA_STANZA =
  `\nif (!process.env.O8_BUILD_GIT_SHA) process.env.O8_BUILD_GIT_SHA = ${JSON.stringify(bakedBuildGitSha)};\n`;

// Early-boot crash guard (Rock 2): observe crashes that happen BEFORE Next's
// instrumentation hook installs the full crash capture. Self-contained (no
// imports of app code), best-effort, never throws. Appends the same JSONL shape
// src/lib/telemetry/crash-store.ts uses, honouring the same data-dir env vars,
// with a coarse 1MB ceiling so a boot-loop can't grow the file unbounded.
const BOOT_CAPTURE_STANZA = `
(function installBootCrashCapture() {
  try {
    const bfs = require('node:fs');
    const bos = require('node:os');
    const bpath = require('node:path');
    const dir = bpath.join(process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || bpath.join(bos.homedir(), '.o8'), 'telemetry');
    const file = bpath.join(dir, 'crashes.jsonl');
    const write = (kind, err) => {
      try {
        bfs.mkdirSync(dir, { recursive: true });
        try { if (bfs.existsSync(file) && bfs.statSync(file).size > 1000000) return; } catch (e) {}
        const msg = err && err.message ? err.message : String(err);
        const rec = { ts: Date.now(), source: 'boot', appVersion: process.env.O8_APP_VERSION || 'unknown', kind: kind, message: String(msg).slice(0, 2000) };
        if (err && err.stack) rec.stack = String(err.stack).slice(0, 8000);
        bfs.appendFileSync(file, JSON.stringify(rec) + '\\n', 'utf8');
      } catch (e) { /* swallow */ }
    };
    process.on('uncaughtExceptionMonitor', (err) => write('uncaughtException', err));
    process.on('unhandledRejection', (reason) => write('unhandledRejection', reason));
  } catch (e) { /* telemetry must never block boot */ }
})();
`;

// ── Server bundle ──
// Next's stock standalone entry ships as server-impl.js; server.js becomes a
// thin wrapper that stamps the REAL TCP peer address into x-o8-client-addr on
// every request (overwriting any client-supplied value) before Next sees it.
// The middleware gate treats that header as socket truth — without it, the
// loopback check rests on the spoofable Host header. The Tauri sidecar's
// process detection matches on the literal name "server.js", so the wrapper
// must keep that name.
for (const f of ['server.js', 'package.json']) {
  const src = join(standalone, f);
  if (!existsSync(src)) continue;
  if (f === 'server.js') {
    cpSync(src, join(server, 'server-impl.js'));
    continue;
  }
  cpSync(src, join(server, f));
}
writeFileSync(join(server, 'server.js'), `// o8 production entry — stamps the TCP peer address into x-o8-client-addr
// so the auth middleware can distinguish loopback from LAN without trusting
// client-controlled headers. Generated by scripts/tauri-export.mjs.

// ── V8 compile cache (Node 22+). MUST be first: it only caches what is required
// AFTER it is enabled. ──
//
// The sidecar spends a large share of its boot simply COMPILING JavaScript —
// not running it, not opening the database (better-sqlite3 is ~30ms), just
// turning bytes on disk into bytecode. Measured on the operator's Intel box,
// CPU-profiled at boot (CPU time, because wall-clock here is bimodal with page
// cache state):
//
//     compile cache OFF   CPU 1401ms   CJS loader 398ms
//     compile cache ON    CPU 1103ms   CJS loader 147ms   (-298ms, 1.27x)
//
// This is the phase the loader spins in front of, so it is time the operator
// spends watching a spinner on every single launch.
//
// Safety: the cache keys on file CONTENT, so a new build simply misses and
// repopulates — it cannot serve stale code across an update. It lives in the
// user data dir (never inside the read-only .app), and every failure is
// swallowed: this is an optimisation, never a requirement.
try {
  const { enableCompileCache } = require('node:module');
  // If NODE_COMPILE_CACHE is already in the environment, Node has ALREADY enabled
  // the cache before this file ran, and calling enableCompileCache() again would
  // be a redundant second enable of the same thing. The Tauri shell sets that env
  // var for every Node child (ws-server has no wrapper to hook, so it can only be
  // reached that way), which means the packaged app takes the env path and this
  // call is only for standalone runs -- dev, tests, \`node out/server/server.js\`.
  if (typeof enableCompileCache === 'function' && !process.env.NODE_COMPILE_CACHE) {
    const nodePath = require('node:path');
    const nodeOs = require('node:os');
    const dataDir = process.env.O8_DATA_DIR
      || process.env.CORTEX_IDE_DATA_DIR
      || nodePath.join(nodeOs.homedir(), '.o8');
    enableCompileCache(nodePath.join(dataDir, 'compile-cache'));
  }
} catch { /* never let a cache failure stop the server booting */ }

// Select the immutable packaged prebuild for the user's Node ABI and
// architecture before either package loads. This must never copy or chmod files
// inside the signed app bundle; native-bundle.mjs removes build/ at export time.
// macOS only: the multi-ABI prebuild layout exists solely for the darwin
// dual-arch artifact. Windows/Linux bundles keep the host-compiled
// build/Release binaries, which load through the normal require path —
// running the darwin selector there crashed the server at boot (#1673).
if (process.platform === 'darwin') {
  require('./native-addon-runtime.cjs').prepareNativeAddons(__dirname);
}

const http = require('node:http');
const https = require('node:https');
const { isAllowedLocalHost, requestTargetAllowed, browserWriteAllowed } = require('./http-request-boundary.cjs');

function stampClientAddr(server) {
  // Ensure upgrade requests reach the boundary even without an app listener.
  const upgradeSentinel = () => {};
  server.on('upgrade', upgradeSentinel);
  const emit = server.emit;
  server.emit = function (event, ...args) {
    if (event !== 'request' && event !== 'upgrade') return emit.call(this, event, ...args);
    const [req, target] = args;
    const hasUpgradeHandler = event === 'upgrade' && this.rawListeners('upgrade').some(listener => listener !== upgradeSentinel);
    const refuse = (status) => {
      const text = status === 421 ? 'Misdirected Request' : 'Origin is not allowed';
      if (event === 'upgrade') target.end('HTTP/1.1 ' + status + ' ' + text + '\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n');
      else { target.writeHead(status, { 'Connection': 'close', 'Content-Type': 'text/plain' }); target.end(text); }
      return true;
    };
    try {
      // PORT identifies Next's app listener, not auxiliary servers such as the
      // authenticated browser egress proxy, whose Host names the destination.
      // Keep the boundary enabled if the app port cannot be identified.
      const appPort = Number(process.env.PORT);
      if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535
        || req.socket?.localPort === appPort) {
        if (!isAllowedLocalHost(req.headers.host, req.socket.localPort)
          || !requestTargetAllowed(req.url, req.socket.localPort)) return refuse(421);
        const get = (name) => typeof req.headers[name] === 'string' ? req.headers[name] : null;
        if (!browserWriteAllowed(req.method, get, req.socket?.encrypted ? 'https:' : 'http:')) return refuse(403);
      }
      const peer = req.socket?.remoteAddress || '';
      const loopbackPeer = peer === '::1' || peer === '127.0.0.1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
      const requestedRelaySurface = req.headers['x-o8-relay-surface'];
      delete req.headers['x-o8-relay-surface'];
      // The o8 relay connector (a same-host loopback process) forwards a remote
      // phone's request and sets x-o8-relay-forward so the auth gate treats it as
      // REMOTE (Bearer required), never loopback-trusted (relay-v1 change 1).
      // Honored ONLY from a loopback peer, and it can ONLY restrict (loopback ->
      // remote), never escalate -- so it is not a spoof/escalation vector.
      // See src/lib/mobile/relay-connector.ts (RELAY_FORWARD_MARKER).
      if (loopbackPeer && req.headers['x-o8-relay-forward'] === '1') {
        req.headers['x-o8-client-addr'] = 'o8-relay-forward';
        if (requestedRelaySurface === 'web-machine') {
          req.headers['x-o8-relay-surface'] = 'web-machine';
        }
      } else {
        req.headers['x-o8-client-addr'] = peer;
      }
    } catch { return refuse(421); }
    if (event === 'upgrade' && !hasUpgradeHandler) { target.destroy(); return true; }
    return emit.call(this, event, ...args);
  };
  return server;
}

const origHttpCreate = http.createServer;
http.createServer = function (...args) {
  return stampClientAddr(origHttpCreate.apply(this, args));
};
const origHttpsCreate = https.createServer;
https.createServer = function (...args) {
  return stampClientAddr(origHttpsCreate.apply(this, args));
};
${RELEASE_ENV_STANZA}${SENTRY_ENV_STANZA}${APP_VERSION_STANZA}${BUILD_GIT_SHA_STANZA}${BOOT_CAPTURE_STANZA}
process.env.O8_PACKAGED_APP = '1';
require('./server-impl.js');
`);
console.log('📦 Wrote server.js wrapper (socket-addr stamping) + server-impl.js');
cpSync(join(root, 'scripts', 'lib', 'http-request-boundary.cjs'), join(server, 'http-request-boundary.cjs'));
cpSync(nativeAddonRuntimePath, join(server, 'native-addon-runtime.cjs'));
console.log('📦 Copied native addon runtime selector');

// node_modules
const mods = join(standalone, 'node_modules');
if (existsSync(mods)) {
  cpSync(mods, join(server, 'node_modules'), { recursive: true });
  console.log('📦 Copied node_modules');
}

// .next (server chunks + static)
const nextDir = join(standalone, '.next');
if (existsSync(nextDir)) {
  cpSync(nextDir, join(server, '.next'), { recursive: true });
}
cpSync(staticDir, join(server, '.next', 'static'), { recursive: true });
console.log('📦 Copied .next');

// public
if (existsSync(pub)) {
  cpSync(pub, join(server, 'public'), { recursive: true });
  console.log('📦 Copied public');
}

// ── Copy native modules + create Turbopack hash symlinks ──
const nativeModules = ['better-sqlite3', 'node-pty'];
for (const mod of nativeModules) {
  const src = join(root, 'node_modules', mod);
  const dest = join(server, 'node_modules', mod);
  if (existsSync(src)) {
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    console.log(`📦 Copied native module: ${mod}`);
  }
}

// The multi-ABI bundle (darwin x64 + arm64 prebuilds, codesigned) exists
// because macOS ships ONE artifact to both arches. Off-macOS builds (#1673,
// #1672) are single-platform: the host-compiled modules copied above are the
// right ones, and codesign doesn't exist there.
if (process.platform === 'darwin') {
  try {
    const nativeBundle = await prepareNativeBundle({ projectRoot: root, serverRoot: server });
    const abiSummary = Object.entries(nativeBundle.nodeAbis)
      .map(([major, abi]) => `Node ${major}=ABI ${abi}`)
      .join(', ');
    console.log(`📦 Bundled better-sqlite3 + node-pty x64 + arm64 (${abiSummary})`);
    for (const asset of nativeBundle.betterSqlite3.assets) {
      console.log(`   ${asset.cacheSource === 'cache' ? 'cache' : 'cached download'}: ${asset.cachePath}`);
    }
    console.log(`📦 Signed and verified ${nativeBundle.nativeSigning.binaries.length} nested Mach-O binaries`);
  } catch (error) {
    console.error(`❌ multi-ABI native addon export failed: ${error.message}`);
    process.exit(1);
  }
} else {
  console.log('📦 Non-darwin build: keeping host-compiled native modules (no multi-ABI bundle, no codesign)');
}

// ── Compile WS server ──
const { execFileSync, execSync } = await import('child_process');

// Turbopack renames externals with hash suffixes — create symlinks
const chunksDir = join(server, '.next', 'server', 'chunks');
if (existsSync(chunksDir)) {
  try {
    // Pure Node instead of grep|head — neither exists for cmd.exe (#1673).
    const hashRe = /better-sqlite3-[a-f0-9]+/;
    let grepResult = '';
    const scan = (dir) => {
      if (grepResult) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (grepResult) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        const m = hashRe.exec(readFileSync(full, 'utf-8'));
        if (m) { grepResult = m[0]; return; }
      }
    };
    scan(chunksDir);
    if (grepResult) {
      const aliasPath = join(server, 'node_modules', grepResult);
      if (!existsSync(aliasPath)) {
        // Copy instead of symlink — Tauri bundler doesn't follow symlinks
        cpSync(join(server, 'node_modules', 'better-sqlite3'), aliasPath, { recursive: true });
        console.log(`📦 Copied better-sqlite3 → ${grepResult} (Turbopack alias)`);
      }
    }
  } catch (e) { console.warn('⚠️  Symlink step:', e.message); }
}

// Keep the export and the per-PR size gate on the same build contract. Load
// tooling only after the export input guards have accepted the staging tree.
try {
  const { bundleServers } = await import('./lib/server-bundles.mjs');
  const { outputs } = bundleServers({ root, outDir: server });
  console.log(`Compiled shared server bundles (${outputs.reduce((sum, output) => sum + output.bytes, 0)} bytes)`);
} catch (error) {
  console.error('Server compilation failed — refusing to ship a broken bundle');
  console.error(error.message);
  process.exit(1);
}

// ── Bundle the Pi SDK worker (#3255) ──
// The packaged server runs from Resources/server; piSdkScriptPath() looks for
// the worker in pi-sdk/ there. One file, so the Pi packages' node_modules never
// ship. Loaded here, like esbuild above, so the input guards run before any
// build tooling is resolved. The approved-write helper is native and ships as
// an externalBin (#3289).
try {
  const { bundlePiSdk } = await import('./lib/pi-sdk-bundle.mjs');
  bundlePiSdk({ root, outDir: join(server, 'pi-sdk') });
  console.log('📦 Bundled pi-sdk/worker.mjs');
} catch (e) {
  console.error('❌ Pi SDK bundle failed — refusing to ship a broken bundle');
  console.error(`   ${e.message}`);
  process.exit(1);
}

// ── Copy runtime-read prompt templates next to the bundles ──
// orchestrator-session.ts resolves orchestrator.md via `import.meta.url`, so
// the file has to sit next to the bundled ws-server.mjs at runtime. In dev it
// lives alongside the source file; here we mirror it into out/server/.
const ORCHESTRATOR_PROMPT_SRC = join(root, 'src', 'lib', 'lane', 'orchestrator.md');
const ORCHESTRATOR_PROMPT_DST = join(server, 'orchestrator.md');
if (existsSync(ORCHESTRATOR_PROMPT_SRC)) {
  cpSync(ORCHESTRATOR_PROMPT_SRC, ORCHESTRATOR_PROMPT_DST);
} else {
  console.error('❌ Missing orchestrator.md at', ORCHESTRATOR_PROMPT_SRC);
  process.exit(1);
}

// Decomposition pipeline template (#538). The pipeline probes a handful of
// layout-specific locations at runtime (cwd-relative, standalone-relative,
// bundle-adjacent). Copying it to two spots covers both prod layouts — the
// Next.js standalone cwd AND the out/server root where esbuild drops the
// other runtime-read prompts.
const DECOMPOSE_PROMPT_SRC = join(root, 'src', 'lib', 'dispatch', 'prompts', 'decompose.md');
const DECOMPOSE_PROMPT_DST = join(server, 'prompts', 'decompose.md');
const DECOMPOSE_PROMPT_STANDALONE_DST = join(server, 'src', 'lib', 'dispatch', 'prompts', 'decompose.md');
if (existsSync(DECOMPOSE_PROMPT_SRC)) {
  mkdirSync(dirname(DECOMPOSE_PROMPT_DST), { recursive: true });
  cpSync(DECOMPOSE_PROMPT_SRC, DECOMPOSE_PROMPT_DST);
  mkdirSync(dirname(DECOMPOSE_PROMPT_STANDALONE_DST), { recursive: true });
  cpSync(DECOMPOSE_PROMPT_SRC, DECOMPOSE_PROMPT_STANDALONE_DST);
} else {
  // Missing the prompt is not fatal — the pipeline has an inline fallback so
  // a missed copy still enqueues packets. Warn loudly though; packaging miss.
  console.warn('⚠️  Missing decompose.md at', DECOMPOSE_PROMPT_SRC, '— pipeline will use inline fallback');
}

// ── Build + bundle the agent-facing CLI ──
// Builds cli/dist/o8.mjs via the package's own esbuild config, then writes a
// shell wrapper at out/server/bin/o8. The wrapper uses O8_NODE_BIN when the app
// injected it, then falls back to a login-shell lookup so Finder/minimal-PATH
// sessions do not fail at `#!/usr/bin/env node`.
const CLI_BUILD = join(root, 'cli', 'esbuild.config.mjs');
const CLI_OUTPUT = join(root, 'cli', 'dist', 'o8.mjs');
const CLI_WORKER_LOGIN_OUTPUT = join(root, 'cli', 'dist', 'worker-login.mjs');
const CLI_BIN_DIR = join(server, 'bin');
const CLI_BIN_DST = join(CLI_BIN_DIR, 'o8');
const CLI_BUNDLE_DST = join(CLI_BIN_DIR, 'o8.mjs');
if (existsSync(CLI_BUILD)) {
  console.log('   building cli bundle…');
  execFileSync(process.execPath, [CLI_BUILD], {
    stdio: 'inherit',
    cwd: join(root, 'cli'),
    env: canonicalizeServerOnlyStubEnv(process.env),
  });
  if (!existsSync(CLI_OUTPUT) || !existsSync(CLI_WORKER_LOGIN_OUTPUT)) {
    console.error(`❌ CLI build did not produce ${CLI_OUTPUT}`);
    process.exit(1);
  }
  mkdirSync(CLI_BIN_DIR, { recursive: true });
  cpSync(CLI_OUTPUT, CLI_BUNDLE_DST);
  cpSync(CLI_WORKER_LOGIN_OUTPUT, join(CLI_BIN_DIR, 'worker-login.mjs'));
  writeFileSync(CLI_BIN_DST, `#!/bin/sh
set -eu
# Resolve the REAL script location through symlinks — o8 is invoked via
# /usr/local/bin/o8 -> <app bundle>/server/bin/o8, and dirname "$0" alone
# pointed at /usr/local/bin, so o8.mjs was never found (every PATH invocation,
# including dispatched workers' \`o8 packet report\`, died MODULE_NOT_FOUND).
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink -- "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname -- "$SELF")/$LINK" ;;
  esac
done
DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
NODE_BIN="\${O8_NODE_BIN:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(zsh -l -c 'command -v node' 2>/dev/null || bash -l -c 'command -v node' 2>/dev/null || sh -lc 'command -v node' 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "o8: Node.js 22+ is required. Relaunch o8.app or install Node from https://nodejs.org." >&2
  exit 127
fi
exec "$NODE_BIN" "$DIR/o8.mjs" "$@"
`);
  // chmodSync instead of a chmod shellout — cmd.exe has no chmod (#1673);
  // on Windows the mode bits are a no-op, which is fine (cmd runs by extension).
  chmodSync(CLI_BIN_DST, 0o755);
  chmodSync(CLI_BUNDLE_DST, 0o755);

  // Windows has no shebang/symlink/execute-bit model, so PATH lookup needs an
  // actual .cmd (cmd.exe/PATHEXT) entry next to the same o8.mjs bundle above
  // (#1741, part of #1673). Emitted unconditionally — an inert text file on
  // macOS/Linux that costs nothing to ship.
  //
  // Deliberately NO o8.ps1: PowerShell resolves a bare `o8` to a sibling .ps1
  // ahead of the .cmd, and an unsigned .ps1 is refused under the default
  // execution policy ("running scripts is disabled on this system"). Shipping
  // one therefore BREAKS `o8` in PowerShell on a stock Windows install, where
  // its absence lets PATHEXT fall through to this .cmd, which runs in both
  // shells. Verified in a Windows 11 VM, 2026-08-06.
  const CLI_CMD_DST = join(CLI_BIN_DIR, 'o8.cmd');
  writeFileSync(CLI_CMD_DST, `@echo off\r
setlocal\r
set "NODE_BIN=%O8_NODE_BIN%"\r
if not defined NODE_BIN set "NODE_BIN=node"\r
"%NODE_BIN%" "%~dp0o8.mjs" %*\r
`);
} else {
  console.warn('⚠️  CLI build config missing — skipping `o8` cli bundle');
}

// ── Sanity check: every expected standalone bundle must exist ──
// Belt-and-braces guard against future compile failures slipping through.
const REQUIRED_BUNDLES = ['ws-server.mjs', 'terminal-host.mjs', 'operator-mcp-server.mjs', 'operator-mcp-server-main.mjs', 'operator-mcp-proxy.mjs', 'cortex-mcp-server.mjs'];
for (const bundle of REQUIRED_BUNDLES) {
  for (const required of [bundle, bundle.replace(/\.mjs$/, '-impl.mjs')]) {
    const bundlePath = join(server, required);
    if (!existsSync(bundlePath)) {
      console.error(`❌ Missing required server bundle: ${required}`);
      process.exit(1);
    }
  }
}

// The WS process reports its own crashes, so its Sentry SDK must be compiled
// into the artifact rather than resolved from the pruned standalone runtime.
for (const file of readdirSync(server).filter(file => file.endsWith('.mjs'))) {
  if (/\b(?:import|require)\s*\(\s*['"]@sentry\/node['"]\s*\)/.test(readFileSync(join(server, file), 'utf8'))) {
    console.error(`WS bundle still externalizes @sentry/node: ${file}`);
    process.exit(1);
  }
}

let size = '';
console.log('📦 Removed packaged build inputs', prunePackagedBuildInputs(server));
try { size = execSync(`du -sh "${server}" 2>/dev/null`).toString().trim().split('\t')[0]; } catch { size = '(size n/a on this platform)'; }
console.log('\\n✅ Export complete');
console.log(`   frontend/ → loader HTML`);
console.log(`   server/ → ${size}`);
