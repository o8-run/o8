import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CORTEX_READONLY_TOOLS } from '@/lib/mcp/cortex-readonly-tools';
import { deferredMcpRequest } from '@/lib/mcp/deferred-tools';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { buildCodexOrchestratorPrompt } from './codex-orchestrator-session';
import {
  buildOrchestratorSystemPrompt,
  orchestratorPromptSurface,
  type OrchestratorPromptBackend,
  type OrchestratorPromptSurface,
} from './orchestrator-system-prompt';

const MCP_DIR = new URL('../mcp/', import.meta.url);

function registeredToolNames(files: URL[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^\s+name: '([a-z0-9]+(?:_[a-z0-9]+)+)',/gm)) {
      names.add(match[1]!);
    }
  }
  return names;
}

const CORTEX_TOOLS = registeredToolNames([
  new URL('cortex-mcp-server.ts', MCP_DIR),
  new URL('cortex-worker-tools.ts', MCP_DIR),
]);
const OPERATOR_TOOLS = registeredToolNames(
  readdirSync(new URL('operator-handlers/', MCP_DIR))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => new URL(`operator-handlers/${name}`, MCP_DIR)),
);
const ALL_TOOLS = new Set([...CORTEX_TOOLS, ...OPERATOR_TOOLS,
  ...registeredToolNames([new URL('deferred-tools.ts', MCP_DIR)]),
]);

/** Every registered tool the text names, including unregistered o8/Cortex names. */
function namedTools(prompt: string): string[] {
  const named = new Set<string>();
  for (const match of prompt.matchAll(/\b([a-z0-9]+(?:_[a-z0-9]+)+)\b/g)) {
    const name = match[1]!;
    if (ALL_TOOLS.has(name) || name.startsWith('cortex_') || name.startsWith('o8_')) named.add(name);
  }
  return [...named].sort();
}

function toolsFor(surface: OrchestratorPromptSurface): Set<string> {
  if (surface.dispatch) return ALL_TOOLS;
  return surface.cortexReads ? new Set([...CORTEX_READONLY_TOOLS, 'o8_html_preview', 'o8_html_render', 'o8_visualization_read']) : new Set();
}

const PROFILES: ToolProfile[] = ['full', 'propose', 'solo', 'fable', 'fable-solo'];
const BACKENDS: OrchestratorPromptBackend[] = ['claude', 'codex', 'pi'];

function renderedPrompts(backend: OrchestratorPromptBackend): string[] {
  return [false, true].map(firstRunClarify => buildOrchestratorSystemPrompt('/tmp/example-repo', {
    backend, firstRunClarify,
  })).concat(backend === 'codex' ? [buildCodexOrchestratorPrompt('/tmp/example-repo', '')] : []);
}

async function deferredToolNames(): Promise<string[]> {
  const result = await deferredMcpRequest({ id: 1, method: 'tools/list' }, () => [...ALL_TOOLS].map(name => ({
    name, description: '', inputSchema: { type: 'object' },
  })), true);
  return (result.response!.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);
}

describe('deferred core covers rendered orchestrator instructions', () => {
  it.each(BACKENDS)('loads every tool named by the %s prompt without a search round trip', async backend => {
    const loaded = new Set(await deferredToolNames());
    for (const prompt of renderedPrompts(backend)) {
      expect(namedTools(prompt).filter(name => !loaded.has(name))).toEqual([]);
      expect(prompt).toContain('If o8_tool_search is listed, tools not in your list are reached with o8_tool_search, then o8_tool_call.');
    }
  });

  it('defers everything except prompt-named tools, status, send and the discovery bridge', async () => {
    const required = new Set(['o8_status', 'o8_send', 'o8_tool_search', 'o8_tool_call']);
    for (const backend of BACKENDS) {
      for (const prompt of renderedPrompts(backend)) {
        for (const name of namedTools(prompt)) required.add(name);
      }
    }
    expect((await deferredToolNames()).sort()).toEqual([...required].sort());
  });
});

describe('orchestrator prompt tool scope (#2898)', () => {
  it.each(BACKENDS)('teaches explicit and natural visualization requests to %s without dispatch authority', backend => {
    const prompt = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend, firstRunClarify: false, toolProfile: 'solo' });
    expect(prompt).toContain('`/visualization`');
    expect(prompt).toContain('show me a visualization');
    expect(prompt).toContain('o8_html_preview');
    expect(prompt).toContain('o8_html_render');
    expect(prompt).toContain('o8_visualization_read');
    expect(prompt).toContain('a rendered mock does not');
    expect(prompt).not.toContain('## Orchestrator protocol');
  });
  it('finds the registered tool catalogs it guards', () => {
    expect(readFileSync(new URL('cortex-mcp-server.ts', MCP_DIR), 'utf8')).toContain('...CORTEX_WORKER_TOOLS');
    expect(CORTEX_TOOLS).toContain('cortex_launch_agent');
    expect(CORTEX_TOOLS).toContain('cortex_worker_catalog');
    expect(OPERATOR_TOOLS).toContain('create_mission');
    expect(OPERATOR_TOOLS).toContain('o8_render');
    for (const name of CORTEX_READONLY_TOOLS) expect(CORTEX_TOOLS, name).toContain(name);
  });

  for (const backend of BACKENDS) {
    for (const toolProfile of PROFILES) {
      for (const mcpServers of [true, false]) {
        it(`names only tools a ${backend} ${toolProfile} turn has${mcpServers ? '' : ' with no MCP servers'}`, () => {
          const prompt = buildOrchestratorSystemPrompt('/tmp/example-repo', {
            backend,
            firstRunClarify: false,
            toolProfile,
            mcpServers,
          });
          const available = toolsFor(orchestratorPromptSurface({ backend, toolProfile, mcpServers }));
          expect(namedTools(prompt).filter((name) => !available.has(name))).toEqual([]);
          expect(prompt).not.toMatch(/<!-- o8:|\{\{[A-Z_]+\}\}/);
        });
      }
    }
  }

  it.each(BACKENDS)('teaches subject-bound review and receipt reconciliation on %s', backend => {
    const prompt = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend, firstRunClarify: false });
    expect(prompt).toContain('Generic readOnly delegation creates a new packet');
    expect(prompt).toContain('does not grant access to a sibling checkout or materialize its commit');
    expect(prompt).toContain('Before declaring not-merged or submitting another review');
    expect(prompt).toContain('get_mission_status, get_packet_scope, cortex_list_approvals, and mission_tail');
    expect(prompt).toContain('cannot enforce an extra reviewer prerequisite');
    expect(prompt).toContain('report that limit before dispatch');
    expect(namedTools(prompt).filter(name => !toolsFor(orchestratorPromptSurface({ backend })).has(name))).toEqual([]);
  });

  it('keeps the fleet doctrine on a full turn and drops it on a Solo turn', () => {
    const full = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend: 'claude', firstRunClarify: false });
    const solo = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend: 'claude', firstRunClarify: false, toolProfile: 'solo' });

    for (const heading of ['## Final-message format for dispatch', '## Orchestrator protocol', '## Huddle mode']) {
      expect(full, heading).toContain(heading);
      expect(solo, heading).not.toContain(heading);
    }
    for (const kept of ['### Outcome ownership', '### Adversarial review protocol', 'Outcome, Evidence, Residual, and Decision']) {
      expect(solo, kept).toContain(kept);
    }
    expect(solo).toContain('cortex_list_issues');
  });

  it('lets the orchestrator use gh where the cortex GitHub tools stop (#2901)', () => {
    const full = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend: 'claude', firstRunClarify: false });
    const cortexServer = readFileSync(new URL('cortex-mcp-server.ts', MCP_DIR), 'utf8');

    // cortex_list_issues returns no body and points at gh; nothing in cortex or operator writes issues.
    expect(cortexServer).toContain('Use `gh issue view` for full text.');
    expect(full).not.toMatch(/never use the gh CLI/i);
    for (const command of ['gh issue view', 'gh issue create', 'gh issue comment']) {
      expect(full, command).toContain(command);
    }
    expect(full).toContain('cortex_list_issues');
  });

  it('names no MCP tool in a single-mode Codex prompt, which launches without MCP servers', () => {
    const single = buildCodexOrchestratorPrompt('/tmp/example-repo', 'work directly', {
      toolProfile: 'solo',
      orchestrationMode: 'single',
    });
    const fleet = buildCodexOrchestratorPrompt('/tmp/example-repo', 'fan this out');

    expect(namedTools(single)).toEqual([]);
    expect(single).toContain('`o8 ask`');
    expect(fleet).toContain('cortex_launch_agent');
    expect(fleet).toContain('`cortex_ask` MCP tool');
  });

  it('names the backend running the turn and keeps Claude-only sections off Codex (#2900)', () => {
    const claude = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend: 'claude', firstRunClarify: false });
    const codex = buildCodexOrchestratorPrompt('/tmp/example-repo', 'fan this out');

    expect(claude).toContain('This turn runs on the Claude Code orchestrator backend.');
    expect(codex).toContain('This turn runs on the Codex orchestrator backend.');
    expect(codex).not.toContain('Claude Code orchestrator backend');
    expect(claude).not.toContain('Codex orchestrator backend');

    expect(claude).toContain('### Native backend helpers');
    expect(claude).toContain('native Claude sub-agents');
    for (const claudeOnly of ['### Native backend helpers', 'native Claude sub-agents', 'You are Claude']) {
      expect(codex, claudeOnly).not.toContain(claudeOnly);
    }
    // Backend-neutral dispatch guidance survives on both.
    for (const prompt of [claude, codex]) {
      expect(prompt).toContain('### Inline work vs dispatch');
      expect(prompt).toContain('orchestrator_review');
    }
  });

  it('carries no fixed default backend, closed-issue note, or stale server prefix (#2900)', () => {
    for (const backend of BACKENDS) {
      const prompt = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend, firstRunClarify: false });
      expect(prompt, backend).not.toMatch(/default orchestrator backend|#1045|-p mode|mcp__o8__/);
      // o8 is the product; `cortex_*` appears only as tool names and the `o8 cortex` command.
      expect(prompt.replace(/cortex_[a-z_*]+|o8 cortex \w+/g, ''), backend).not.toMatch(/cortex/i);
    }
  });

  it('states each collapsed prohibition once (#2902)', () => {
    const full = buildOrchestratorSystemPrompt('/tmp/example-repo', { backend: 'claude', firstRunClarify: false });
    const count = (pattern: RegExp) => full.match(new RegExp(pattern.source, `${pattern.flags}g`))?.length ?? 0;

    expect(count(/check back/i), 'promised follow-up').toBe(1);
    expect(count(/merge directly/i), 'direct merge').toBe(1);
    expect(count(/Claim only dispatches that happened/), 'false dispatch').toBe(1);
    expect(count(/after your last tool call/), 'summary after tools').toBe(1);
    expect(full).not.toContain('Forbidden phrasings');
    // Outcome ownership and the review traces carry their rules unchanged.
    for (const kept of ['### Outcome ownership', '### Adversarial review protocol', 'GUARD/PREDICATE TRACE', 'COMPLETENESS TRACE']) {
      expect(full, kept).toContain(kept);
    }
  });
});
