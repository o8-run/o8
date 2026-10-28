import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const marker = /^(?:\uFEFF)?\/\/ @o8-test-browser(?:\r?\n|$)/;
const engines = new Set(['chromium', 'webkit', 'firefox']);
const browserPackages = new Set(['playwright', 'playwright-core']);

function inspect(file, source) {
  // The pre-install selector imports this module without loading the parser.
  const ts = require('typescript');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  const bindingsByName = new Map();
  const definitions = new Map();
  const exportsByName = new Map();
  const exportStars = [];
  const localExports = [];
  const boundImports = new Set();
  const targets = new Map();
  const mocks = new Set();
  const mockedEngines = new Set();
  const spyNames = new Map();
  const mockPositions = new Map();
  const constants = new Map();
  const processes = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']);
  const visit = (node, callback) => { callback(node); ts.forEachChild(node, child => { visit(child, callback); }); };
  for (const node of tree.statements) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) definitions.set(node.name.text, node);
    if (ts.isFunctionDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) definitions.set('default', node);
    if (ts.isExportAssignment(node)) definitions.set('default', node.expression);
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) definitions.set(declaration.name.text, declaration.initializer);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
      if (!node.exportClause) exportStars.push(node.moduleSpecifier.text);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const item of node.exportClause.elements) {
        if (!item.isTypeOnly) exportsByName.set(item.name.text, { specifier: node.moduleSpecifier.text, symbol: (item.propertyName ?? item.name).text });
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const item of node.exportClause.elements) {
        if (!item.isTypeOnly) localExports.push([item.name.text, (item.propertyName ?? item.name).text]);
      }
    }
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) continue;
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    const runtime = !clause || !!clause.name || !bindings || ts.isNamespaceImport(bindings)
      || bindings.elements.some(item => !item.isTypeOnly);
    if (!runtime) continue;
    imports.push(specifier);
    if (clause?.name) bindingsByName.set(clause.name.text, { specifier, symbol: 'default' });
    if (bindings && ts.isNamespaceImport(bindings)) bindingsByName.set(bindings.name.text, { specifier, symbol: '*' });
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if (!item.isTypeOnly) bindingsByName.set(item.name.text, { specifier, symbol: (item.propertyName ?? item.name).text });
    }
    if (specifier === 'node:child_process' || specifier === 'child_process') {
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if (processes.has((item.propertyName ?? item.name).text)) processes.add(item.name.text);
      }
    }
    if (!browserPackages.has(specifier)) continue;
    if (clause?.name) for (const engine of engines) targets.set(`${clause.name.text}.${engine}`, engine);
    if (bindings && ts.isNamespaceImport(bindings)) for (const engine of engines) targets.set(`${bindings.name.text}.${engine}`, engine);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      const engine = (item.propertyName ?? item.name).text;
      if (!item.isTypeOnly && engines.has(engine)) targets.set(item.name.text, engine);
    }
  }
  for (const [exported, original] of localExports) {
    if (definitions.has(original)) definitions.set(exported, definitions.get(original));
    else if (bindingsByName.has(original)) exportsByName.set(exported, bindingsByName.get(original));
  }
  visit(tree, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) constants.set(node.name.text, node.initializer);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && /(?:^|\.)promisify$/.test(node.initializer.expression.getText(tree))
      && node.initializer.arguments.some(argument => processes.has(argument.getText(tree)))) processes.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const call = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isCallExpression(call) && (call.expression.kind === ts.SyntaxKind.ImportKeyword || call.expression.getText(tree) === 'require')
        && ts.isStringLiteralLike(call.arguments[0])) {
        const specifier = call.arguments[0].text;
        imports.push(specifier); boundImports.add(call);
        if (ts.isObjectBindingPattern(node.name)) for (const item of node.name.elements) {
          bindingsByName.set(item.name.getText(tree), { specifier, symbol: (item.propertyName ?? item.name).getText(tree) });
          const engine = (item.propertyName ?? item.name).getText(tree);
          if (browserPackages.has(specifier) && engines.has(engine)) targets.set(item.name.getText(tree), engine);
        }
        if (ts.isIdentifier(node.name)) {
          bindingsByName.set(node.name.text, { specifier, symbol: '*' });
          if (browserPackages.has(specifier)) for (const engine of engines) targets.set(`${node.name.text}.${engine}`, engine);
        }
      }
    }
    if (!ts.isCallExpression(node)) return;
    const name = node.expression.getText(tree);
    if (/^(?:vi|vitest)\.(?:mock|doMock)$/.test(name) && ts.isStringLiteralLike(node.arguments[0])) {
      // Partial mocks that import the real implementation still need auditing.
      const factory = node.arguments[1];
      const importsActual = factory && (/importActual|requireActual|importOriginal/.test(factory.getText(tree))
        || ts.isFunctionLike(factory) && factory.parameters.some(parameter => factory.body?.getText(tree).includes(parameter.name.getText(tree))));
      if (!importsActual) mocks.add(node.arguments[0].text);
    }
    if (!ts.isPropertyAccessExpression(node.expression) || !/^mock(?:ResolvedValue|RejectedValue|Implementation|ReturnValue)$/.test(node.expression.name.text)) return;
    const spy = node.expression.expression;
    if (!ts.isCallExpression(spy) || !/^(?:vi|vitest)\.spyOn$/.test(spy.expression.getText(tree))
      || !spy.arguments[0] || !ts.isStringLiteralLike(spy.arguments[1]) || spy.arguments[1].text !== 'launch') return;
    let ancestor = node;
    while (ancestor.parent && ancestor.parent !== tree) {
      if (ts.isFunctionLike(ancestor) || ts.isIfStatement(ancestor) || ts.isConditionalExpression(ancestor)) return;
      ancestor = ancestor.parent;
    }
    const engine = targets.get(spy.arguments[0].getText(tree));
    if (engine) {
      mockedEngines.add(engine); mockPositions.set(engine, node.end);
      if (ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name)) spyNames.set(ancestor.name.text, engine);
      if (ts.isVariableStatement(ancestor)) for (const declaration of ancestor.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) spyNames.set(declaration.name.text, engine);
      }
    }
  });
  visit(tree, node => {
    if (!ts.isCallExpression(node)) return;
    let ancestor = node.parent;
    while (ancestor && ancestor !== tree) {
      if (ts.isCallExpression(ancestor) && /(?:^|\.)afterAll$/.test(ancestor.expression.getText(tree))) return;
      ancestor = ancestor.parent;
    }
    const name = node.expression.getText(tree);
    if (/^(?:vi|vitest)\.(?:unmock|doUnmock)$/.test(name) && ts.isStringLiteralLike(node.arguments[0])) mocks.delete(node.arguments[0].text);
    if (/^(?:vi|vitest)\.restoreAllMocks$/.test(name)) mockedEngines.clear();
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'mockRestore') {
      const engine = spyNames.get(node.expression.expression.getText(tree));
      if (engine) mockedEngines.delete(engine);
    }
    if (ts.isPropertyAccessExpression(node.expression) && /^launch(?:PersistentContext)?$/.test(node.expression.name.text)) {
      const engine = targets.get(node.expression.expression.getText(tree));
      if (engine && node.getStart(tree) < (mockPositions.get(engine) ?? -1)) mockedEngines.delete(engine);
    }
  });
  const values = (node, seen = new Set(), depth = 0) => {
    if (!node || depth > 32) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node) && !seen.has(node.text)) return values(constants.get(node.text), new Set([...seen, node.text]), depth + 1);
    const result = [];
    ts.forEachChild(node, child => { result.push(...values(child, seen, depth + 1)); });
    return result;
  };
  const browserMocked = [...browserPackages].some(pkg => mocks.has(pkg));
  const contexts = new Map();
  const context = symbol => {
    if (contexts.has(symbol)) return contexts.get(symbol);
    const result = { imports: imports.map(specifier => ({ specifier, symbol: '@init' })), scripts: [], launches: [] };
    if (exportsByName.has(symbol)) result.imports.push(exportsByName.get(symbol));
    if (!symbol.startsWith('@')) for (const specifier of exportStars) result.imports.push({ specifier, symbol });
    contexts.set(symbol, result);
    const pending = [];
    const seen = new Set();
    const reference = expression => {
      const parts = expression.split('.');
      const binding = bindingsByName.get(parts[0]);
      if (binding) result.imports.push({ ...binding, symbol: binding.symbol === '*' ? parts[1] ?? '*' : binding.symbol });
      else if (definitions.has(parts[0]) && !seen.has(parts[0])) {
        seen.add(parts[0]); pending.push({ node: definitions.get(parts[0]), initialization: false });
      }
    };
    const scan = (node, initialization) => {
      const walk = (current, callback) => {
        if (initialization && ts.isFunctionLike(current)
          && !(ts.isCallExpression(current.parent) && current.parent.arguments.includes(current))) return;
        callback(current);
        ts.forEachChild(current, child => { walk(child, callback); });
      };
      walk(node, current => {
        if (!ts.isCallExpression(current)) return;
        const name = current.expression.getText(tree);
        reference(name);
        for (const argument of current.arguments) if (ts.isIdentifier(argument)) reference(argument.text);
        if ((current.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require') && ts.isStringLiteralLike(current.arguments[0])) {
          result.imports.push({ specifier: current.arguments[0].text, symbol: boundImports.has(current) ? '@init' : '*' });
        }
        if (!browserMocked && ts.isPropertyAccessExpression(current.expression) && /^launch(?:PersistentContext)?$/.test(current.expression.name.text)) {
          const engine = targets.get(current.expression.expression.getText(tree));
          if (engine && !mockedEngines.has(engine)) result.launches.push(engine);
        }
        if ([...processes].some(process => new RegExp(`(?:^|[.(])${process}(?:\\)|$)`).test(name))) {
          for (const argument of current.arguments) result.scripts.push(...values(argument).filter(value => /\.[cm]?[jt]sx?$/.test(value)));
        }
      });
    };
    if (symbol === '*') pending.push({ node: tree, initialization: false });
    else {
      if (definitions.has(symbol)) { seen.add(symbol); pending.push({ node: definitions.get(symbol), initialization: false }); }
      for (const statement of tree.statements) {
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) continue;
        if (symbol !== '@main' && ts.isIfStatement(statement) && /import\.meta|require\.main|isMainModule/.test(statement.expression.getText(tree))) continue;
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (declaration.initializer && !ts.isFunctionLike(declaration.initializer)) pending.push({ node: declaration.initializer, initialization: true });
          }
        } else pending.push({ node: statement, initialization: true });
      }
    }
    while (pending.length) { const item = pending.pop(); scan(item.node, item.initialization); }
    return result;
  };
  return { context, mocks, mockedEngines,
    declared: marker.test(source) || !browserMocked && [...targets.values()].some(engine => !mockedEngines.has(engine)),
  };
}

export function declaresBrowser(file, source) {
  if (marker.test(source)) return true;
  if (!/playwright/.test(source)) return false;
  return inspect(file, source).declared;
}

export function assertBrowserDeclarations(root, files) {
  const metadata = new Map();
  const errors = [];
  const safeByPolicy = new Map([['', new Set()]]);
  const sources = new Map();
  const source = file => {
    if (!sources.has(file)) sources.set(file, readFileSync(file, 'utf8'));
    return sources.get(file);
  };
  const load = file => {
    if (!metadata.has(file)) metadata.set(file, inspect(file, source(file)));
    return metadata.get(file);
  };
  const resolve = (file, specifier, script = false) => {
    const bases = specifier.startsWith('@/') ? [path.join(root, 'src', specifier.slice(2))]
      : specifier.startsWith('.') ? [path.resolve(path.dirname(file), specifier)]
        : script ? [path.resolve(root, specifier), path.resolve(path.dirname(file), specifier)] : [];
    for (const base of bases) for (const suffix of ['', '.ts', '.tsx', '.mjs', '.cjs', '.js', '/index.ts', '/index.tsx', '/index.js']) {
      const candidate = base + suffix;
      if (!path.relative(root, candidate).startsWith('..') && /\.[cm]?[jt]sx?$/.test(candidate)
        && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return undefined;
  };
  // Prune modules with no possible browser/process dependency before building
  // their syntax trees. This is only a conservative prefilter; the audit below
  // still resolves runtime calls, exports and mock boundaries.
  const unrelated = new Set();
  const candidates = new Set();
  const mayLaunch = file => {
    const pending = [file]; const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current) || unrelated.has(current)) continue;
      seen.add(current);
      const text = source(current);
      if (candidates.has(current) || /playwright|child_process|\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/.test(text)
        || /\b(?:import|require|from)\s*(?:\(\s*)?\/[/*]/.test(text)) {
        candidates.add(file); return true;
      }
      for (const match of text.matchAll(/\b(?:from|import|require)\s*(?:\(\s*)?(['"`])([^'"`\r\n]+)\1/g)) {
        if (match[2].includes('\\')) { candidates.add(file); return true; }
        const dependency = resolve(current, match[2]);
        if (dependency) pending.push(dependency);
      }
    }
    for (const entry of seen) unrelated.add(entry);
    return false;
  };
  for (const file of files) {
    const absolute = path.join(root, file);
    if (marker.test(source(absolute)) || !mayLaunch(absolute)) continue;
    const initial = load(absolute);
    if (initial.declared) continue;
    const blocked = new Set([...initial.mocks].map(specifier => resolve(absolute, specifier) ?? specifier));
    const policy = [...blocked, ...initial.mockedEngines].sort().join('\0');
    if (!safeByPolicy.has(policy)) safeByPolicy.set(policy, new Set());
    const safe = safeByPolicy.get(policy);
    const beforeErrors = errors.length;
    const pending = [{ file: absolute, symbol: '*' }];
    const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      const key = `${current.file}#${current.symbol}`;
      if (seen.has(key) || safe.has(key) || safeByPolicy.get('').has(key) || blocked.has(current.file)) continue;
      if (!mayLaunch(current.file)) continue;
      seen.add(key);
      const info = load(current.file).context(current.symbol);
      if (![...browserPackages].some(pkg => blocked.has(pkg))
        && info.launches.some(engine => current.symbol === '@init' || !initial.mockedEngines.has(engine))) {
        errors.push(`${file}: browser launch through ${path.relative(root, current.file).split(path.sep).join('/')}; add // @o8-test-browser as the first line`);
        break;
      }
      for (const { specifier, symbol } of info.imports) {
        if (blocked.has(specifier) || browserPackages.has(specifier)) continue;
        const dependency = resolve(current.file, specifier);
        if (dependency) pending.push({ file: dependency, symbol });
      }
      for (const script of info.scripts) {
        const dependency = resolve(current.file, script, true);
        if (dependency) pending.push({ file: dependency, symbol: '@main' });
      }
    }
    if (errors.length === beforeErrors) for (const key of seen) safe.add(key);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
