import type { NextConfig } from 'next';

const releaseDistDir = process.env.O8_RELEASE_NEXT_DIST_DIR;
if (releaseDistDir && releaseDistDir !== '.next/.o8-release-build') {
  throw new Error('Release output namespace is invalid.');
}

const nextConfig: NextConfig = {
  output: 'standalone',
  distDir: releaseDistDir || '.next',
  // Repository instructions are maintained by the operator, not dev startup.
  agentRules: false,
  outputFileTracingRoot: __dirname,
  outputFileTracingExcludes: {
    // sharp is Next's image optimizer, pulled in transitively. `images.unoptimized`
    // below is required for standalone output, so it is never invoked at runtime —
    // but it ships ~100MB of vendored libvips into the bundle, and that is what
    // breaks the Linux AppImage: linuxdeploy dependency-walks the bundled server's
    // ELFs and dies on sharp's own libvips-cpp, whose soname no system libvips can
    // match (#1747). Excluding dead weight beats teaching the bundler to carry it.
    '*': [
      // Dynamic checkout reads must not turn local metadata into runtime files.
      // Match the directory entry too, since a worktree entry can be a symlink.
      './.git*{,/**/*}',
      './.env*',
      './.mcp.json',
      './.{agents,claude,codex,cortex-worktrees,o8*}{,/**/*}',
      './*explainer*.html',
      // Build cache can enter route traces through filesystem reads. Keep it
      // available to the compiler, but never copy it into the runtime bundle.
      './.next/cache/**/*',
      './.next/.o8-release-*/{cache,dev}/**/*',
      './.next/.o8-release-*/{trace,trace-build}',
      './.next/dev/**/*',
      './.next/trace',
      './.next/trace-build',
      // The shell ships the staged Pi write helper separately and supplies
      // O8_PI_WRITE_BIN. Its source-checkout Cargo target tree is not runtime
      // input; transient objects can disappear while standalone copies traces.
      './src-tauri/sidecars/pi-write/target{,/**/*}',
      '**/node_modules/sharp/**/*',
      '**/node_modules/@img/**/*',
      // Browserslist data is used by Next's build tools, never by the server.
      '**/node_modules/caniuse-lite/**/*',
      // The aliased highlighter bundles common data and fetches optional data.
      // NFT also follows the original Shiki registries, duplicating every
      // grammar/theme. Keep the package-name indexes used by the asset route.
      '**/node_modules/@shikijs/{langs,themes}/dist/!(index).mjs',
      '**/node_modules/@pierre/theme/dist/!(index).mjs',
    ],
  },
  // better-sqlite3 is a native module. The Pi packages load Node built-ins
  // (node:sqlite, node:fs) through dynamic imports a bundler stubs out, so
  // Node loads them as published.
  serverExternalPackages: ['typescript', 'better-sqlite3', '@earendil-works/pi-ai', '@earendil-works/pi-durable', '@earendil-works/chord', '@muse-code/sdk'],
  reactStrictMode: true,
  devIndicators: false,
  images: {
    unoptimized: true, // Required for standalone — no image optimization server
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'github.com',
      },
    ],
  },
  experimental: {
    // Next otherwise requires every route at boot, retaining unused feature
    // chunks and their module-level state for the entire sidecar lifetime.
    preloadEntriesOnStart: false,
    // Runtime response caches must not mutate the signed standalone app.
    // Compiled responses remain readable and the in-memory cache stays enabled.
    isrFlushToDisk: false,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-src http://localhost:* http://127.0.0.1:* 'self'; frame-ancestors 'self'",
          },
        ],
      },
    ];
  },
  turbopack: {},
  webpack: (config, { dev }) => {
    // Pierre imports Shiki's all-language/all-theme entry points. Keep the app's
    // common grammars local and resolve optional syntax assets on demand.
    config.resolve.alias = {
      ...config.resolve.alias,
      'shiki$': `${__dirname}/src/lib/highlighting/shiki-bundle.ts`,
      '@pierre/theming/themes$': `${__dirname}/src/lib/highlighting/pierre-themes.ts`,
    };
    if (dev) {
      return config;
    }

    // Force heavy libraries into separate chunks for parallel loading + caching
    config.optimization = {
      ...config.optimization,
      splitChunks: {
        ...(typeof config.optimization?.splitChunks === 'object' ? config.optimization.splitChunks : {}),
        cacheGroups: {
          ...(typeof config.optimization?.splitChunks === 'object'
            ? (config.optimization.splitChunks as Record<string, unknown>).cacheGroups as Record<string, unknown>
            : {}),
          monaco: {
            test: /[\\/]node_modules[\\/](monaco-editor|@monaco-editor)[\\/]/,
            name: 'vendor-monaco',
            // Worker runtimes keep their compiler code out of the UI vendor
            // chunk. Worker entries are async too, so 'async' is insufficient.
            chunks: (chunk: { runtime?: string | Set<string> }) => {
              const runtimes = typeof chunk.runtime === 'string' ? [chunk.runtime] : [...(chunk.runtime ?? [])];
              return runtimes.some(runtime => runtime === 'webpack' || runtime === 'webpack-runtime');
            },
            priority: 30,
          },
          xterm: {
            test: /[\\/]node_modules[\\/]@xterm[\\/]/,
            name: 'vendor-xterm',
            chunks: 'all' as const,
            priority: 30,
          },
          framerMotion: {
            test: /[\\/]node_modules[\\/]framer-motion[\\/]/,
            name: 'vendor-framer',
            chunks: 'all' as const,
            priority: 20,
          },
          mermaid: {
            test: /[\\/]node_modules[\\/]mermaid[\\/]/,
            name: 'vendor-mermaid',
            chunks: 'async' as const,
            priority: 30,
          },
        },
      },
    };

    return config;
  },
  // o8's dev flow standardizes on http://127.0.0.1:47120, but Next dev's
  // cross-origin protection only allows `localhost` by default and its
  // REJECTION of the HMR WebSocket upgrade is not valid HTTP — every real
  // browser on the IP origin logged ERR_INVALID_HTTP_RESPONSE, the Turbopack
  // dev client hung in a retry loop, and hydration never completed with zero
  // errors surfaced (#1731). Origin-less probes (curl, bare `ws`) sailed
  // through, which is why the server looked healthy from every non-browser
  // measurement. Prod is unaffected: the check is dev-only.
  allowedDevOrigins: ['127.0.0.1'],
  // No rewrites. A vestigial `/ws → http://127.0.0.1:3002` proxy rewrite
  // (dead port; relayed surfaces use the machine transport and direct clients
  // dial ws://<host>:<wsPort> themselves) was removed during the #1731 hunt —
  // it was NOT the cause, just dead config not worth restoring.
};

export default nextConfig;
