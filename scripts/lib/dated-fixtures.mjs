import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const DAY = 86_400_000;
const EXPIRY = /expir|^valid_?(?:until|to)$|^not_?after$/i;
const ROOTS = ['src', 'tests', 'cli', 'scripts', 'config', 'fixtures', 'contracts'];
const EXTENSION = /\.(?:[cm]?js|tsx?|json)$/;

function walk(directory, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'target') continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (entry.isFile() && EXTENSION.test(entry.name)) files.push(file);
  }
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => { visit(child, callback); });
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
  return node;
}

function literalValue(node, constants, seen = new Set()) {
  node = unwrap(node);
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteralLike(node)) {
    return /^\d{4}-\d\d-\d\d(?:T.*)?$/.test(node.text) ? Date.parse(node.text) : undefined;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    return literalValue(constants.get(node.text), constants, new Set([...seen, node.text]));
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const object = unwrap(constants.get(node.expression.text));
    if (object && ts.isObjectLiteralExpression(object)) {
      const field = object.properties.find(p => p.name?.getText().replaceAll(/['"]/g, '') === node.name.text);
      if (field && ts.isPropertyAssignment(field)) return literalValue(field.initializer, constants, seen);
    }
  }
  if (ts.isBinaryExpression(node)) {
    const a = literalValue(node.left, constants, seen);
    const b = literalValue(node.right, constants, seen);
    if (a === undefined || b === undefined) return undefined;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
    if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return a - b;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
  }
  if (ts.isCallExpression(node)) {
    const name = node.expression.getText();
    if (name === 'Date.UTC') {
      const args = node.arguments.map(arg => literalValue(arg, constants, seen));
      if (args.length >= 2 && args.every(arg => Number.isFinite(arg))) return Date.UTC(...args);
    }
    if (name === 'Date.parse') return literalValue(node.arguments[0], constants, seen);
    if (ts.isPropertyAccessExpression(node.expression)
      && ['getTime', 'toISOString', 'valueOf'].includes(node.expression.name.text)) {
      return literalValue(node.expression.expression, constants, seen);
    }
  }
  if (ts.isNewExpression(node) && node.expression.getText() === 'Date' && node.arguments?.length === 1) {
    return literalValue(node.arguments[0], constants, seen);
  }
  return undefined;
}

function parse(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.json') ? ts.ScriptKind.JSON : file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const constants = new Map();
  visit(tree, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) constants.set(node.name.text, node.initializer);
  });
  return { tree, constants };
}

function jsonFixturePaths(source, file, root) {
  if (!source.includes('.json') || file.endsWith('.json')) return [];
  const { tree, constants } = parse(source, file);
  function pathValue(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      if (node.text === '__dirname') return dirname(file);
      if (!seen.has(node.text)) return pathValue(constants.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isNewExpression(node) && node.expression.getText() === 'URL'
      && node.arguments?.[1]?.getText() === 'import.meta.url') {
      const path = pathValue(node.arguments[0], seen);
      if (path && !path.includes(':')) return resolve(dirname(file), path);
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText();
      if (name === 'process.cwd') return root;
      if (/(?:^|\.)(?:join|resolve)$/.test(name)) {
        const args = node.arguments.map(arg => pathValue(arg, seen));
        if (args.length && args.every(arg => typeof arg === 'string')) return resolve(root, ...args);
      }
      if (/(?:^|\.)fileURLToPath$/.test(name)) return pathValue(node.arguments[0], seen);
    }
    return undefined;
  }
  const paths = new Set();
  visit(tree, node => {
    if (!ts.isCallExpression(node) || !node.arguments.length) return;
    const path = pathValue(node.arguments[0]);
    if (!path?.endsWith('.json') || path.includes('://')) return;
    const absolute = resolve(root, path);
    if (!relative(root, absolute).startsWith('..') && existsSync(absolute) && statSync(absolute).isFile()) {
      const canonical = realpathSync(absolute);
      if (!relative(root, canonical).startsWith('..')) paths.add(canonical);
    }
  });
  return [...paths];
}

function expiryRecords(source, file) {
  if (!EXPIRY.test(source)) return [];
  const { tree, constants } = parse(source, file);
  const records = [];
  visit(tree, node => {
    if (!(ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node))
      || !node.name || !EXPIRY.test(node.name.getText())) return;
    let at = literalValue(node.initializer, constants);
    // Epoch seconds are also common in JSON fixtures. Zero/one are invalid-bound
    // fixtures, not calendar dates whose meaning changes on a future day.
    if (at >= 946_684_800 && at < 100_000_000_000) at *= 1000;
    if (!Number.isFinite(at) || at < Date.UTC(2000, 0) || at > Date.UTC(2200, 0)) return;
    records.push({ at, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  });
  return records;
}

function callName(node) {
  let expression = node.expression;
  while (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression)) {
    expression = expression.expression;
  }
  return ts.isIdentifier(expression) ? expression.text : '';
}

function callback(call) {
  return call.arguments.find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))?.body;
}

function restoresDate(body) {
  let restores = false;
  function scan(node) {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && /^(?:vi|vitest)\.useRealTimers$/.test(node.expression.getText())) restores = true;
    ts.forEachChild(node, scan);
  }
  scan(body);
  return restores;
}

function pinsDate(body, constants) {
  if (restoresDate(body)) return false;
  let fakeDate = false;
  let fixedTime = false;
  let workBeforePin = false;
  function scan(node) {
    // A declaration of a helper or a nested test does not execute its clock setup.
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isIterationStatement(node, false)
      || ts.isSwitchStatement(node) || ts.isTryStatement(node)) {
      if (!(fakeDate && fixedTime)) workBeforePin = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText();
      if (!/^(?:vi|vitest)\.|^Date\.(?:UTC|parse)$/.test(name) && !(fakeDate && fixedTime)) workBeforePin = true;
      if (/^(?:vi|vitest)\.useFakeTimers$/.test(name)) {
        const options = node.arguments[0];
        fakeDate = !options;
        if (options && ts.isObjectLiteralExpression(options)) {
          const fields = new Map(options.properties.filter(ts.isPropertyAssignment)
            .map(p => [p.name.getText().replaceAll(/['"]/g, ''), p.initializer]));
          const toFake = fields.get('toFake');
          fakeDate = !toFake || (ts.isArrayLiteralExpression(toFake)
            && toFake.elements.some(item => ts.isStringLiteral(item) && item.text === 'Date'));
          fixedTime = literalValue(fields.get('now'), constants) !== undefined;
        }
      }
      if (/^(?:vi|vitest)\.setSystemTime$/.test(name)) {
        fixedTime = literalValue(node.arguments[0], constants) !== undefined;
      }
      if (/^(?:vi|vitest)\.useRealTimers$/.test(name)) { fakeDate = false; fixedTime = false; }
    }
    ts.forEachChild(node, scan);
  }
  scan(body);
  return fakeDate && fixedTime && !workBeforePin;
}

function hasUnpinnedTest(source, file) {
  const { tree, constants } = parse(source, file);
  const tests = [];
  visit(tree, node => {
    if (ts.isCallExpression(node) && ['it', 'test'].includes(callName(node)) && callback(node)) tests.push(node);
  });
  if (!tests.length) return true;
  return tests.some(test => {
    if (restoresDate(callback(test))) return true;
    if (pinsDate(callback(test), constants)) return false;
    for (let scope = test.parent; scope; scope = scope.parent) {
      if (!(ts.isSourceFile(scope) || ts.isBlock(scope))) continue;
      const hooks = scope.statements.flatMap(statement => {
        const call = ts.isExpressionStatement(statement) ? statement.expression : undefined;
        return call && ts.isCallExpression(call) && callName(call) === 'beforeEach' && callback(call)
          ? [callback(call)] : [];
      });
      if (hooks.some(restoresDate)) return true;
      if (hooks.some(body => pinsDate(body, constants))) return false;
    }
    return true;
  });
}

/** Conservative policy: every hermetic test reaching a fixed expiry must pin
 * Date, even if a particular assertion only serializes the fixture. This avoids
 * depending on a list of validator names or on whether the fixture expires today.
 */
export function auditDatedFixtures(root, hermeticFiles, now = Date.now()) {
  root = realpathSync(root);
  const files = [];
  for (const directory of ROOTS) walk(join(root, directory), files);
  const metadata = new Map();
  const display = file => relative(root, file).split(sep).join('/');
  const resolveImport = (file, specifier) => {
    const base = specifier.startsWith('@/') ? join(root, 'src', specifier.slice(2))
      : specifier.startsWith('.') ? resolve(dirname(file), specifier) : undefined;
    if (!base || relative(root, base).startsWith('..')) return undefined;
    const candidates = [base, ...['.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx'].map(ext => base + ext)];
    if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
    return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  };
  function inspect(file) {
    if (metadata.has(file)) return metadata.get(file);
    const source = readFileSync(file, 'utf8');
    const imports = file.endsWith('.json') ? []
      : ts.preProcessFile(source, true, true).importedFiles.map(item => item.fileName);
    const result = { source, expiries: expiryRecords(source, file),
      imports: [...new Set([...imports.map(specifier => resolveImport(file, specifier)).filter(Boolean),
        ...jsonFixturePaths(source, file, root)])] };
    metadata.set(file, result);
    return result;
  }
  for (const file of files.sort()) inspect(file);
  // Propagate dated dependencies once, including cycles, rather than walking
  // the shared application graph again for every hermetic test.
  const importers = new Map();
  for (const [file, info] of metadata) {
    for (const dependency of info.imports) {
      inspect(dependency);
      if (!importers.has(dependency)) importers.set(dependency, new Set());
      importers.get(dependency).add(file);
    }
  }
  const datedFiles = new Map([...metadata].filter(([, info]) => info.expiries.length).map(([file]) => [file, file]));
  const queue = [...datedFiles.keys()];
  for (let index = 0; index < queue.length; index++) {
    const dependency = queue[index];
    for (const importer of importers.get(dependency) ?? []) {
      if (datedFiles.has(importer)) continue;
      datedFiles.set(importer, datedFiles.get(dependency));
      queue.push(importer);
    }
  }
  const errors = [];
  for (const path of hermeticFiles) {
    const file = join(root, path);
    const dated = datedFiles.get(file);
    if (dated && hasUnpinnedTest(inspect(file).source, file)) {
      errors.push(`${path}: pin Date in beforeEach (useFakeTimers + a fixed setSystemTime/now); fixed expiry in ${display(dated)}`);
    }
  }
  const warnings = [];
  for (const [file, info] of [...metadata].sort(([a], [b]) => a.localeCompare(b))) {
    for (const { at, line } of info.expiries) {
      const remaining = at - now;
      if (remaining >= 0 && remaining <= 7 * DAY) {
        warnings.push(`${display(file)}:${line} expires ${new Date(at).toISOString()} (within 7 days)`);
      }
    }
  }
  return { errors, warnings };
}
