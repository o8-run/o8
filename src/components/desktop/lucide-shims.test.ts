import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Activity, AlertCircle } from './lucide-shims';

describe('Lucide raw SVG shims', () => {
  it('type-checks deep icon data against the package declaration without implicit any', () => {
    const root = process.cwd();
    const fixturePath = join(root, 'src/components/desktop/lucide-shims-typecheck.tsx');
    const source = `
      import type { IconNode } from 'lucide-react/dist/lucide-react';
      import { __iconNode } from 'lucide-react/dist/esm/icons/activity.js';
      import { Activity } from './lucide-shims';
      type Assert<T extends true> = T;
      type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
        (<T>() => T extends B ? 1 : 2) ? true : false;
      export type MatchesPackage = Assert<Equal<typeof __iconNode, IconNode>>;
      export type IsTyped = Assert<0 extends (1 & typeof __iconNode) ? false : true>;
      export const icon = <Activity size={18} strokeWidth={1.5} aria-label="Activity" />;
      // @ts-expect-error Icon data must retain the package's SVG tag union.
      const invalidTag: typeof __iconNode = [['not-an-svg-element', {}]];
      // @ts-expect-error Icon attributes must retain their string values.
      const invalidAttribute: typeof __iconNode = [['path', { d: false }]];
    `;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2017,
      jsx: ts.JsxEmit.ReactJSX,
      types: ['react'],
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, ...args) => file === fixturePath
      ? ts.createSourceFile(file, source, languageVersion, true, ts.ScriptKind.TSX)
      : getSourceFile(file, languageVersion, ...args);
    // Like the CLI checker, discover declarations through the shim import graph.
    const program = ts.createProgram([fixturePath], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
    expect(diagnostics).toEqual([]);
  });

  it('renders paths and caller props through the existing raw SVG entry point', () => {
    const activity = renderToStaticMarkup(createElement(Activity, {
      size: 18, color: 'red', strokeWidth: 1.5, 'aria-label': 'Activity',
    }));
    expect(activity).toContain('<svg');
    expect(activity).toContain('width="18" height="18"');
    expect(activity).toContain('stroke="red" stroke-width="1.5"');
    expect(activity).toContain('aria-label="Activity"');
    expect(activity).toContain('<path');
    expect(renderToStaticMarkup(createElement(AlertCircle))).toContain('<circle');
  });
});
