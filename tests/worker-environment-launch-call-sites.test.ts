import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = process.cwd();
const boundary = 'src/lib/providers/child-process.ts';
// These run before the Node 22/native-store bootstrap. They must use the same
// dependency-free ambient builder explicitly, rather than load the store early.
const bootstrap = new Set(['src/lib/mcp/operator-node22-locator.ts', 'src/lib/mcp/operator-node22-reexec.ts']);
const operations = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\./.test(file) ? [file] : [];
  });
}

it('enumerates process creation imports and rejects paths outside the shared environment boundary', () => {
  const violations: string[] = [];
  const sites: string[] = [];
  for (const file of sources(join(root, 'src'))) {
    const name = relative(root, file).replaceAll('\\', '/');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const bindings = new Set<string>();
    const rawBindings = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier) && /^(node:)?child_process$/.test(statement.moduleSpecifier.text)
        && (!statement.exportClause || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.some(item => !item.isTypeOnly))
        && name !== boundary) violations.push(`${name}: raw process re-export`);
      if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference)
        && statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression)
        && /^(node:)?child_process$/.test(statement.moduleReference.expression.text)
        && name !== boundary) violations.push(`${name}: raw process require import`);
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const moduleName = statement.moduleSpecifier.text;
      const raw = moduleName === 'child_process' || moduleName === 'node:child_process';
      if (!raw && !moduleName.endsWith('/providers/child-process') && moduleName !== './child-process') continue;
      const imports = statement.importClause?.namedBindings;
      if (imports && ts.isNamedImports(imports)) {
        for (const item of imports.elements) if (!item.isTypeOnly && operations.has((item.propertyName ?? item.name).text)) {
          bindings.add(item.name.text);
          if (raw) rawBindings.add(item.name.text);
        }
      } else if (raw && name !== boundary) violations.push(`${name}: raw process namespace`);
      if (rawBindings.size && name !== boundary && !bootstrap.has(name)) violations.push(`${name}: raw process import`);
    }
    const visit = (node: ts.Node) => {
      const rawEnvironment = (expression: ts.Node) => ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression) && expression.expression.text === 'process' && expression.name.text === 'env';
      if (bindings.size && (ts.isSpreadAssignment(node) && rawEnvironment(node.expression)
        || ts.isPropertyAssignment(node) && node.name.getText(source) === 'env' && rawEnvironment(node.initializer))) {
        violations.push(`${name}: ambient environment promoted to explicit launch input`);
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression) && bindings.has(expression.text)) {
          sites.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          if (bootstrap.has(name) && rawBindings.has(expression.text)
            && !node.arguments.some(argument => argument.getText(source).includes('workerParentEnvironment('))) violations.push(`${name}: bootstrap launch lacks allowlist`);
        }
        if ((expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(expression) && expression.text === 'require')
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && /^(node:)?child_process$/.test(node.arguments[0].text)
          && name !== boundary) violations.push(`${name}: dynamic raw process import`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(sites.length, 'production launch inventory must not be empty').toBeGreaterThan(100);
  expect(violations).toEqual([]);
  console.info(`[environment-boundary] enumerated ${sites.length} production launch call sites; zero bypasses`);
});

it('includes dispatch process fixtures in the resource-owning classification', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'tests/test-classification.json'), 'utf8'));
  const entries = Object.values(manifest).flatMap(value => Array.isArray(value) ? value : []);
  expect(entries.some(entry => entry?.path === 'tests/worker-environment-dispatch-real-path.test.ts'), 'dispatch fixture must be classified').toBe(true);
});
