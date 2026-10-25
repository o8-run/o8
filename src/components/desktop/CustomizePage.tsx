'use client';

/** Live customization inventories and scoped installation flows. */

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { toast } from '@/components/shared/ConfirmToastHost';
import { RamsButton } from './settings/shared';
import { ProjectInstructions } from './customize/ProjectInstructions';
import { emptyInventory, isIndexedDocumentation, loadCustomizeInventory, type CustomizeInventory, type CustomizeRepo, type ExternalServer, type AgentEntry, type HookEntry } from './customize/inventory';
import { InstructionsTab } from './customize/InstructionsTab';
import type { ProjectRecord } from './repo-registry/useProjects';
import { CustomizeHeader, type CustomizeTab } from './customize/CustomizeHeader';
import { useCustomizeTab } from './customize/navigation';
import { ORCHESTRATOR_SLASH_COMMANDS } from '@/lib/slash-commands/definitions';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { insertPromptIntoActiveComposer, type PromptLibraryEntry } from '@/lib/prompt-library/client';
import { PromptLibraryTab } from './customize/PromptLibraryTab';
import { AddSkillForm } from './customize/AddSkillForm';
import { SkillsInventoryTab } from './customize/SkillsInventoryTab';
import { DetailLine, EmptyState, OpenFileLink, Row, SectionHeader, TruncatedRows } from './customize/shared';
import { WORKSPACE_PAGE_MAX_WIDTH, WORKSPACE_PAGE_TOP_PADDING } from './WorkspacePageHeader';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono, "SF Mono", Menlo, monospace)';

const PluginsTab = dynamic(() => import('./customize/PluginsTab'), {
  loading: () => <p style={{ color: 'var(--t-text-muted)' }}>Opening plugins…</p>,
});
const InstructionBundlesPanel = dynamic(() => import('./customize/InstructionBundlesPanel'), {
  loading: () => <p style={{ color: 'var(--t-text-muted)' }}>Opening skill bundles…</p>,
});

/** o8's own always-on MCP servers — shown so "all connections" is honest. */
const BUILTIN_CONNECTIONS: Array<{ name: string; detail: string }> = [
  { name: 'o8 operator', detail: 'Missions, approvals, webview control — the operator MCP surface' },
  { name: 'cortex', detail: 'Fleet, issues, PRs — internal orchestrator tools' },
];

function openSettingsMcpTab() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab: 'mcp' } }));
}

export function CustomizePage({ onClose, project = null, registeredRepos = [], onOpenPluginTerminal, fixedTab }: {
  onClose?: () => void;
  onOpenPluginTerminal?: (terminal: { sessionName: string; label: string; workspaceRoot: string | null }) => Promise<void>;
  project?: ProjectRecord | null;
  registeredRepos?: CustomizeRepo[];
  fixedTab?: 'plugins';
}) {
  const [navigationTab, setTab] = useCustomizeTab();
  const tab = fixedTab ?? navigationTab;
  const [query, setQuery] = useState('');
  const [pluginRepo, setPluginRepo] = useState('');
  const [addingSkill, setAddingSkill] = useState(false);
  const [skillNotice, setSkillNotice] = useState('');
  const [selection, setSelection] = useState({ projectId: project?.id, value: 'all' });
  const projectPaths = JSON.stringify(project?.repoPaths ?? []);
  const repos = useMemo(() => {
    const paths = JSON.parse(projectPaths) as string[];
    return paths.map((localPath) => ({
      localPath,
      name: registeredRepos.find((repo) => repo.localPath === localPath)?.name ?? localPath.split('/').filter(Boolean).pop() ?? localPath,
    }));
  }, [projectPaths, registeredRepos]);
  const requestedScope = selection.projectId === project?.id ? selection.value : 'all';
  const scope = requestedScope === 'personal' || repos.some((repo) => repo.localPath === requestedScope) ? requestedScope : 'all';
  const repoPath = scope === 'all' || scope === 'personal' ? null : scope;
  const selectedRepos = scope === 'personal' ? [] : repoPath ? repos.filter((repo) => repo.localPath === repoPath) : repos;
  const requestKey = JSON.stringify([project?.id, scope, selectedRepos]);
  const [loaded, setLoaded] = useState<{ key: string; data: CustomizeInventory; error: string | null } | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const loading = loaded?.key !== requestKey;
  const { directives, servers, agents, hooks, skills } = loading ? emptyInventory : loaded.data;
  const inventoryError = loading ? null : loaded.error;
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const [, requestedScope, requestedRepos] = JSON.parse(requestKey) as [string | null, string, CustomizeRepo[]];
    void loadCustomizeInventory(requestedRepos, requestedScope === 'personal' || !project?.id, controller.signal, project?.id)
      .then((data) => { if (!controller.signal.aborted) setLoaded({ key: requestKey, data, error: null }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ key: requestKey, data: emptyInventory, error: error instanceof Error ? error.message : 'Could not load customizations.' });
      });
    return () => controller.abort();
  }, [requestKey, refreshCount, project?.id]);

  useEffect(() => {
    const refresh = () => setRefreshCount(count => count + 1);
    window.addEventListener('o8:cortex-changes', refresh);
    return () => window.removeEventListener('o8:cortex-changes', refresh);
  }, []);

  const activeRepoName = repos.find((repo) => repo.localPath === repoPath)?.name ?? 'Personal';
  const q = query.trim().toLowerCase();
  const matches = (...fields: Array<string | null | undefined>) =>
    !q || fields.some((field) => field?.toLowerCase().includes(q));

  // Navigation counts show inventory totals rather than filtered results.
  const tabCounts: Partial<Record<CustomizeTab, number>> = {
    rules: directives.filter((d) => !isIndexedDocumentation(d)).length,
    commands: ORCHESTRATOR_SLASH_COMMANDS.length,
    skills: skills.length,
    connections: BUILTIN_CONNECTIONS.length + servers.length,
    agents: agents.length,
    hooks: hooks.length,
  };

  // Open a customization's backing file in the app's file viewer. The
  // dashboard carries an always-mounted o8:open-file listener (added with this
  // surface — O8Panel's own listener unmounts under the takeover), so closing
  // and dispatching immediately is race-free.
  const openFile = (path: string) => {
    onClose?.();
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:open-file', { detail: { path } }));
  };

  const insertTaskText = (body: string) => {
    onClose?.();
    if (typeof window === 'undefined') return;
    let attempts = 0;
    const deadline = Date.now() + 3000;
    const insertWhenReady = () => {
      if (insertPromptIntoActiveComposer(body)) return;
      attempts += 1;
      if (attempts < 180 && Date.now() < deadline) window.requestAnimationFrame(insertWhenReady);
      else toast('Text was not inserted. Open a task, then try again.', 'error');
    };
    window.requestAnimationFrame(insertWhenReady);
  };

  const useSkill = async (skill: { name: string; file: string; repoPath?: string }) => {
    try {
      const params = new URLSearchParams({ file: skill.file });
      if (skill.repoPath) params.set('repo', skill.repoPath);
      const response = await fetch(`/api/customize/skills?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Could not read this skill.');
      insertTaskText(`Use the ${JSON.stringify(skill.name)} skill for this task. Its instructions are included below. Supporting files are not included.\n\n${data.instructions}\n\n`);
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not add the skill to your draft.', 'error'); }
  };

  return (
    <div style={{
      height: '100%',
      minHeight: 0,
      overflowY: 'auto',
      scrollbarWidth: 'none',
      background: 'var(--t-chat-surface-bg, var(--t-canvas-bg))',
      fontFamily: UI_FONT,
    }} className="cortex-themed-scroll">
      <div style={{
        width: '100%',
        maxWidth: WORKSPACE_PAGE_MAX_WIDTH,
        marginLeft: 'auto',
        marginRight: 'auto',
        paddingTop: WORKSPACE_PAGE_TOP_PADDING,
        paddingBottom: 64,
        paddingLeft: 28,
        paddingRight: 28,
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}>
        <CustomizeHeader
          pluginsOnly={fixedTab === 'plugins'}
          tab={tab} onTab={(next) => { setTab(next); setExpandedRow(null); }}
          query={query} onQuery={setQuery} repos={repos} scope={scope}
          onScope={(value) => { setSelection({ projectId: project?.id, value }); setExpandedRow(null); }} project={project}
          counts={loading ? {} : tabCounts} onClose={onClose}
        />

        {tab === 'rules' && scope !== 'personal' && project ? <ProjectInstructions key={project.id} project={project} /> : null}

        {/* Keep section changes immediate. */}
        {tab === 'plugins' ? (
          <PluginsTab onOpenTerminal={onOpenPluginTerminal} repoPath={repoPath} repos={repos} onSelectRepo={(path) => setSelection({ projectId: project?.id, value: path ?? 'all' })} />
        ) : loading ? (
          <div style={{ paddingTop: 32, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)' }}>Loading…</div>
        ) : inventoryError ? (
          <div role="alert" style={{ paddingTop: 24, color: 'var(--t-text-secondary)', fontSize: 13 }}>{inventoryError} <RamsButton variant="ghost" onClick={() => setRefreshCount((value) => value + 1)}>Retry</RamsButton></div>
        ) : tab === 'rules' ? (
          <InstructionsTab key={requestKey} query={query.trim()} correctionRepoPaths={project ? selectedRepos.map(repo => repo.localPath) : undefined} directives={directives} expandedRow={expandedRow} onToggleRow={setExpandedRow} onOpenFile={openFile} />
        ) : tab === 'connections' ? (
          <ConnectionsTab servers={servers.filter((s) => matches(s.name, s.command, s.url))} query={q} expandedRow={expandedRow} onToggleRow={setExpandedRow} />
        ) : tab === 'commands' ? (
          <CommandsTab query={q} />
        ) : tab === 'prompts' ? (
          <PromptLibraryTab
            key={requestKey}
            query={q}
            repoPath={repoPath}
            repoName={activeRepoName}
            repoPaths={selectedRepos.map((repo) => repo.localPath)}
            onInsert={(prompt: PromptLibraryEntry) => insertTaskText(prompt.body)}
            onCountDelta={() => {}}
          />
        ) : tab === 'skills' ? (
          <>
            {addingSkill ? <AddSkillForm repos={repos} initialRepo={repoPath} onCancel={() => setAddingSkill(false)} onSaved={(savedRepo) => { setAddingSkill(false); setQuery(''); setSelection({ projectId: project?.id, value: savedRepo ?? 'personal' }); setRefreshCount((value) => value + 1); setSkillNotice('Skill saved. Open it below or use it in a task.'); }} /> : <div><RamsButton variant="primary" onClick={() => { setAddingSkill(true); setSkillNotice(''); }}>Add skill</RamsButton></div>}
            {skillNotice ? <p role="status" style={{ color: 'var(--t-text-muted)', fontSize: 13 }}>{skillNotice}</p> : null}
            <SkillsInventoryTab skills={skills} query={q} onOpenFile={openFile} onUseSkill={useSkill} />
            <InstructionBundlesPanel selectedRepo={pluginRepo} onSelectRepo={setPluginRepo} repos={repos} onChanged={() => setRefreshCount((value) => value + 1)} onUseSkill={useSkill} />
          </>
        ) : tab === 'agents' ? (
          <AgentsTab agents={agents.filter((a) => matches(a.name, a.description, a.repoName))} expandedRow={expandedRow} onToggleRow={setExpandedRow} onOpenFile={openFile} />
        ) : (
          <HooksTab hooks={hooks.filter((h) => matches(h.event, h.command, h.matcher, h.repoName))} onOpenFile={openFile} />
        )}
      </div>
    </div>
  );
}

// ── Tabs ──

function ConnectionsTab({ servers, query, expandedRow, onToggleRow }: {
  servers: ExternalServer[];
  query: string;
  expandedRow: string | null;
  onToggleRow: (id: string | null) => void;
}) {
  const builtins = BUILTIN_CONNECTIONS.filter((b) => !query || b.name.includes(query) || b.detail.toLowerCase().includes(query));
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionHeader label="o8 built-in" count={builtins.length} />
      {builtins.map((builtin) => (
        <Row key={builtin.name} title={builtin.name} titleMono subtitle={builtin.detail} pill="always on" />
      ))}

      <SectionHeader label="External MCP servers" count={servers.length} />
      {servers.length === 0 ? (
        <EmptyState
          title="No external MCP servers"
          body="Connect services in Settings to make their tools available to supported agents. Access depends on the agent and its permissions."
          actionLabel="Add in Settings"
          onAction={openSettingsMcpTab}
        />
      ) : <TruncatedRows rows={servers.map((server) => (
        <Row
          key={server.id}
          title={server.name}
          titleMono
          dot={server.enabled === false ? 'gray' : 'green'}
          subtitle={server.transport === 'http' ? server.url ?? 'http' : server.command ?? 'stdio'}
          pill={server.transport}
          expanded={expandedRow === server.id}
          onClick={() => onToggleRow(expandedRow === server.id ? null : server.id)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <DetailLine label="Transport" value={server.transport} />
            {server.command ? <DetailLine label="Command" value={server.command} mono /> : null}
            {server.url ? <DetailLine label="URL" value={server.url} mono /> : null}
            <DetailLine label="Status" value={server.enabled === false ? 'Disabled' : 'Enabled'} />
            <button
              type="button"
              onClick={openSettingsMcpTab}
              style={{
                alignSelf: 'flex-start',
                marginTop: 2,
                border: 'none',
                background: 'transparent',
                padding: 0,
                fontSize: 12,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                color: 'var(--t-accent, #2563eb)',
                cursor: 'pointer',
                fontFamily: UI_FONT,
              }}
            >
              Open in Settings ›
            </button>
          </div>
        </Row>
      ))} />}
    </div>
  );
}

function CommandsTab({ query }: { query: string }) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof ORCHESTRATOR_SLASH_COMMANDS>();
    for (const command of ORCHESTRATOR_SLASH_COMMANDS) {
      if (query && !command.command.toLowerCase().includes(query) && !command.description.toLowerCase().includes(query)) continue;
      const group = command.group ?? 'general';
      const list = byGroup.get(group) ?? [];
      list.push(command);
      byGroup.set(group, list);
    }
    return [...byGroup.entries()];
  }, [query]);

  if (groups.length === 0) {
    return <EmptyState title="No matching commands" body="Slash commands run from the orchestrator composer — type / to use them." />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {groups.map(([group, commands]) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column' }}>
          <SectionHeader label={group} count={commands.length} />
          <TruncatedRows rows={commands.map((command) => (
            <Row
              key={command.command}
              title={command.command}
              titleMono
              subtitle={command.description}
              pill={command.argHint ?? null}
            />
          ))} />
        </div>
      ))}
    </div>
  );
}

function AgentsTab({ agents, expandedRow, onToggleRow, onOpenFile }: {
  agents: AgentEntry[];
  expandedRow: string | null;
  onToggleRow: (id: string | null) => void;
  onOpenFile: (path: string) => void;
}) {
  const user = agents.filter((a) => a.scope === 'user');
  const project = agents.filter((a) => a.scope === 'project');
  if (agents.length === 0) {
    return (
      <EmptyState
        title="No agent definitions"
        body="Subagent definitions live in .claude/agents (repo) and ~/.claude/agents (user) — markdown files with a name, description, and system prompt."
      />
    );
  }
  const section = (label: string, list: AgentEntry[]) => (
    list.length > 0 ? (
      <>
        <SectionHeader label={label} count={list.length} />
        <TruncatedRows rows={list.map((agent) => (
          <Row
            key={agent.file}
            title={agent.name}
            titleMono
            subtitle={[agent.repoName, agent.description].filter(Boolean).join(' · ')}
            expanded={expandedRow === agent.file}
            onClick={() => onToggleRow(expandedRow === agent.file ? null : agent.file)}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agent.description ? (
                <div style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>{agent.description}</div>
              ) : null}
              <DetailLine label="File" value={agent.file} mono />
              <OpenFileLink file={agent.file} onOpenFile={onOpenFile} />
            </div>
          </Row>
        ))} />
      </>
    ) : null
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {section('Personal', user)}
      {section('Repositories', project)}
    </div>
  );
}

function HooksTab({ hooks, onOpenFile }: { hooks: HookEntry[]; onOpenFile: (path: string) => void }) {
  const user = hooks.filter((h) => h.scope === 'user');
  const project = hooks.filter((h) => h.scope === 'project');
  if (hooks.length === 0) {
    return (
      <EmptyState
        title="No hooks configured"
        body="Hooks run shell commands on agent lifecycle events (PreToolUse, PostToolUse, SessionStart) — configured in .claude/settings.json."
      />
    );
  }
  const section = (label: string, list: HookEntry[]) => (
    list.length > 0 ? (
      <>
        <SectionHeader label={label} count={list.length} />
        <TruncatedRows rows={list.map((hook, index) => (
          <div
            key={`${hook.scope}-${hook.event}-${index}`}
            role="button"
            tabIndex={0}
            title={`Open ${hook.file}`}
            onClick={() => onOpenFile(hook.file)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpenFile(hook.file);
              }
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingTop: 7,
              paddingBottom: 7,
              paddingLeft: 10,
              paddingRight: 10,
              borderRadius: 9,
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--t-text)', fontFamily: MONO_FONT }}>{hook.event}</span>
              {hook.repoName ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{hook.repoName}</span> : null}
              {hook.matcher ? (
                <span style={{ fontSize: 10.5, color: 'var(--t-text-faint)', fontFamily: MONO_FONT }}>{hook.matcher}</span>
              ) : null}
            </div>
            <span style={{
              fontSize: 11,
              color: 'var(--t-text-muted)',
              fontFamily: MONO_FONT,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {hook.command}
            </span>
          </div>
        ))} />
      </>
    ) : null
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {section('Personal', user)}
      {section('Repositories', project)}
    </div>
  );
}

export default CustomizePage;
