import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import reactHooks from 'eslint-plugin-react-hooks';

const wkWebViewApiGuardMessage = 'Use safeRequestIdleCallback from @/lib/util/webview-safe — requestIdleCallback is undefined in the macOS WKWebView (see directive cortex-ide-wkwebview-api-guard).';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      '.next/**',
      '**/.next/**',
      '.cortex-worktrees/**',
      '.claude/worktrees/**',
      'node_modules/**',
      '**/node_modules/**',
      '**/.cortex-worktrees/**',
      'out/**',
      'build/**',
      'dist/**',
      'cli/dist/**',
      'coverage/**',
      'electron/**',
      'src-tauri/target/**',
      'native/o8-next/target/**',
      '.o8-next-cargo/**',
      // Native Cargo dependencies retain upstream tooling, not app TypeScript.
      'src-tauri/vendor/**',
      // Generated from src/lib/browser/native-agent-source.ts by scripts/next/browser-agent-source.ts.
      'native/o8-next/src/browser_panel/agent.js',
      'test-results/**',
      'tmp/**',
      'next-env.d.ts',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['**/*.cjs'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // CommonJS files require() by definition — the TS-oriented rule doesn't apply.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      // #1191 — these five are React Compiler (react-hooks v7) ADVISORY rules.
      // Ratified at 'warn' by decision: they flag patterns the compiler can't
      // auto-memoize, not correctness bugs, and the ~97 current hits live mostly
      // in the inline-style-heavy desktop surfaces where the churn to satisfy
      // them outweighs the benefit. Kept as warnings (surfaced, never CI-blocking).
      // Revisit as a focused fix-pass only if the count grows or a real bug
      // traces to one of these patterns.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      'no-restricted-globals': ['error',
        {
          name: 'requestIdleCallback',
          message: wkWebViewApiGuardMessage,
        },
        {
          name: 'cancelIdleCallback',
          message: wkWebViewApiGuardMessage,
        },
      ],
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name=/^(requestIdleCallback|cancelIdleCallback)$/]',
          message: wkWebViewApiGuardMessage,
        },
        {
          selector: 'CallExpression[callee.object.name="window"][callee.property.name=/^(requestIdleCallback|cancelIdleCallback)$/]',
          message: wkWebViewApiGuardMessage,
        },
        {
          selector: 'MemberExpression[object.name="window"][property.name=/^(requestIdleCallback|cancelIdleCallback)$/]',
          message: wkWebViewApiGuardMessage,
        },
      ],
    },
  },
  {
    files: ['src/app/api/**/*.ts', 'src/lib/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/lib/util/webview-safe.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];

export default config;
