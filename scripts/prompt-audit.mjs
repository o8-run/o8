// Offline inventory of repository-authored prompt text. No provider calls.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const changed = new Set(base ? execFileSync('git', ['diff', '--name-only', base], { encoding: 'utf8' }).trim().split('\n') : []);
const promptName = /prompt|instructions|prelude|guidance|outcome.rules|reviewer.limitations/i;
const notPrompt = /(?:Path|Icon|Glyph|Style|Preview|History|Library|Stash|Storage|Changed|VERSION|PromptId|shouldPrompt|promptFor$)/i;
const extraBuilders = new Set(['appendFeedback', 'renderReadBudgetSections', 'renderEdgeCaseSections', 'buildPreservationEnvelope', 'checkFileSizeThresholds', 'formatPacketTaskContractForReview', 'buildSonnetComposeSystem', 'buildSonnetComposeUser', 'buildAdversarialReviewProtocol', 'appendCodexAutoReviewVerdictInstructions']);
const nativeBuilders = new Set(['catalog_block', 'escalate_block', 'tool_lookup_message', 'lookup_budget_spent_message', 'conversation_context', 'text_tool_result_message']);
const assets = new Set([
  'src/lib/lane/orchestrator.md', 'src/lib/prompts/v1/symon-native-system.txt',
  'src/lib/dispatch/prompts/decompose.md', '.claude/agents/reviewer.md',
]);
// Inline model messages whose enclosing function does not have a prompt name.
const inlineSources = new Map([
  ['src/lib/chat/compaction.ts', 'Chat compression'],
  ['src/lib/orchestrator/auto-compact.ts', 'Thread compression and digest'],
  ['src/lib/cortex/qa/contradictions.ts', 'Contradiction judgment'],
  ['src/lib/projects/suggest.ts', 'Project suggestion'],
  ['src/lib/intake/github-intake.ts', 'Issue planning'],
  ['src/lib/o8md/spec-review.ts', 'Specification review'],
  ['src/lib/ci-repair/prompt.ts', 'Check repair'],
  ['src/lib/dispatch/decomposition-pipeline.ts', 'Task decomposition'],
  ['src/lib/judgment/questions.ts', 'Typed judgment'],
  ['src/lib/review/architecture-attention.ts', 'Architecture review ordering'],
]);

function source(file, ref) {
  try {
    return ref && changed.has(file) ? execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : readFileSync(file, 'utf8');
  } catch { return ''; }
}

function purpose(file) {
  if (file.includes('/mcp/')) return 'Tool selection, arguments and authority';
  if (/review/.test(file)) return 'Independent review and evidence';
  if (/handoff|carry|compact|recall/.test(file)) return 'Continuation and retained context';
  if (/steer|rerun/.test(file)) return 'Operator correction and retry';
  if (/cortex|fact-extraction/.test(file)) return 'Retrieval, classification and grounding';
  if (/worker|packet|delegate|dispatch|task/.test(file)) return 'Worker scope, launch and completion';
  if (/orchestrator/.test(file)) return 'Orchestration and tool authority';
  return 'Model input and output contract';
}

function withoutRustTests(text) {
  // Mask strings/comments for brace matching, retaining source offsets. In
  // particular, a cfg(test) module declaration does not hide later production.
  const masked = text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|r(#+)"[\s\S]*?"\1|"(?:[^"\\]|\\[\s\S])*"|'(?:\\.|[^'\\])'/g, (value) => ' '.repeat(value.length));
  const ranges = [];
  for (const match of masked.matchAll(/#\[(?:cfg\(test\)|(?:tokio::)?test(?:\([^\]]*\))?)\]/g)) {
    const start = match.index;
    const tail = masked.slice(start + match[0].length);
    const boundary = tail.search(/[;{]/);
    if (boundary < 0) continue;
    let end = start + match[0].length + boundary + 1;
    if (masked[end - 1] === '{') {
      let depth = 1;
      while (end < masked.length && depth > 0) {
        if (masked[end] === '{') depth += 1;
        if (masked[end] === '}') depth -= 1;
        end += 1;
      }
    }
    ranges.push([start, end]);
  }
  let production = text;
  for (const [start, end] of ranges.reverse()) production = production.slice(0, start) + ' '.repeat(end - start) + production.slice(end);
  return production;
}

function catalog(ref) {
  const groups = new Map();
  function add(file, name, text, slots = 0) {
    const id = `${file}#${name}`;
    const item = groups.get(id) ?? { id, file, name, purpose: inlineSources.get(file) ?? purpose(file), chars: 0, slots: 0 };
    item.chars += text.length;
    item.slots += slots;
    groups.set(id, item);
  }
  for (const file of files) {
    if (file === 'scripts/prompt-audit.mjs') continue;
    if (/test|fixture|__mocks__/.test(file) || !/^(src\/|src-tauri\/|scripts\/|\.claude\/)/.test(file)) continue;
    const text = source(file, ref);
    if (!text) continue;
    if (/prompt-library|prompt-stash|customize\/|voice-settings\/|api\/setup\//.test(file)) continue;
    if (/TranscriptNavigator|OrchestratorPromptControls|thoughts\/utils\.ts/.test(file)) continue;
    if (assets.has(file)) { add(file, 'asset', text); continue; }
    if (file.endsWith('.rs')) {
      const production = withoutRustTests(text);
      const functions = [...production.matchAll(/\bfn\s+(\w+)\s*\(/g)];
      for (let index = 0; index < functions.length; index += 1) {
        const match = functions[index];
        if (!/prompt|instructions/.test(match[1]) && !nativeBuilders.has(match[1])) continue;
        const body = production.slice(match.index, functions[index + 1]?.index ?? production.length);
        const literals = [...body.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)].map((part) => part[0].slice(1, -1));
        add(file, match[1], literals.join(''));
      }
      for (const match of production.matchAll(/\bconst\s+(\w*(?:PROMPT|CONTRACT|TAIL|NUDGE|UNTRUSTED_NOTE|RESULT_NOTE)\w*)\s*:[\s\S]*?=\s*"((?:[^"\\]|\\[\s\S])*)"/g)) {
        add(file, match[1], match[2]);
      }
      let toolIndex = 0;
      for (const match of production.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/g)) {
        add(file, `native-tool-description-${++toolIndex}`, match[1]);
      }
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        // Template spans are counted once at the template expression, including nested literals as slots.
        let ancestor = node.parent;
        while (ancestor && !ts.isTemplateExpression(ancestor)) ancestor = ancestor.parent;
        if (ancestor) return;
        let owner = null;
        let description = false;
        let system = false;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isPropertyAssignment(parent)) {
            const key = parent.name.getText(ast).replace(/['"]/g, '');
            description ||= key === 'description' && /\/lib\/(?:mcp|voice|symon)\//.test(file);
            system ||= /^(system|systemPrompt|instructions|promptTemplate)$/.test(key);
            if (key === 'content' && ts.isObjectLiteralExpression(parent.parent)) {
              system ||= parent.parent.properties.some((property) => ts.isPropertyAssignment(property)
                && property.name.getText(ast) === 'role' && /^(?:'|")(?:system|developer)(?:'|")$/.test(property.initializer.getText(ast)));
            }
          }
          if (description && ts.isObjectLiteralExpression(parent)) {
            const name = parent.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'name');
            if (name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer)) {
              owner = `tool:${name.initializer.text}`; break;
            }
          }
          if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name) {
            const name = parent.name.getText(ast);
            const builder = ts.isFunctionDeclaration(parent) ? /^(?:build|render|with|format)/.test(name) : true;
            if ((promptName.test(name) && !notPrompt.test(name) && builder) || extraBuilders.has(name)
              || (file.includes('/prompts/') && /^build/.test(name))) { owner = name; break; }
            if (system) { owner = `${name}:message`; break; }
          }
        }
        if (!owner && description) owner = 'tool-schema-descriptions';
        if (!owner && inlineSources.has(file) && node.getText(ast).length > 100) owner = 'inline-model-context';
        if (owner) {
          const content = ts.isTemplateExpression(node)
            ? node.head.text + node.templateSpans.map((span) => span.literal.text).join('')
            : node.text;
          add(file, owner, content, ts.isTemplateExpression(node) ? node.templateSpans.length : 0);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return [...groups.values()].filter((row) => row.chars >= 40 || row.slots > 0).sort((a, b) => a.id.localeCompare(b.id));
}

const current = catalog(null);
const previous = new Map((base ? catalog(base) : current).map((row) => [row.id, row]));
const rows = current.map((row) => ({ ...row, before: Math.ceil((previous.get(row.id)?.chars ?? 0) / 4), after: Math.ceil(row.chars / 4) }));
for (const old of previous.values()) {
  if (!rows.some((row) => row.id === old.id)) rows.push({ ...old, before: Math.ceil(old.chars / 4), after: 0 });
}
rows.sort((a, b) => a.id.localeCompare(b.id));
if (args.includes('--json')) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
else {
  const markdown = [
    '# Prompt source inventory', '',
    'Generated by `node scripts/prompt-audit.mjs --base <audit-base> --write`.', '',
    'These are static fragment budgets, estimated as `ceil(UTF-16 characters / 4)`, matching',
    '`src/lib/skeleton/renderer.ts`. A symbol row sums its literal fragments across branches;',
    'it is not a rendered request total. Interpolated task text, retrieved rows, transcripts,',
    'repository instructions, external tool descriptions, and plugin prompts are variable inputs.',
    'Slots counts template substitutions; function arguments and joins can add further content.',
    'The fixed rendered-request table in [the audit](./prompt-audit.md) measures the main paths.', '',
    'Discovery scans tracked production script and application prompt/instruction/prelude symbols,',
    'inline model-message sources, prompt assets, and MCP tool plus schema descriptions.',
    'Transport code forwards user/history/plugin text without a finite static token size.',
    'Native rows count source string fragments in prompt builders and JSON tool descriptions;',
    'escaped source characters and format slots make them conservative source estimates, not wire totals.', '',
    '| Source | Symbol / template | Purpose | Before ~tokens | After ~tokens | Slots |',
    '| --- | --- | --- | ---: | ---: | ---: |',
    ...rows.map((row) => `| [${row.file}](../../${row.file}) | ${row.name.replaceAll('|', '/')} | ${row.purpose} | ${row.before} | ${row.after} | ${row.slots} |`), '',
  ].join('\n');
  if (args.includes('--write')) writeFileSync('docs/internals/prompt-inventory.md', markdown);
  else process.stdout.write(markdown);
}
