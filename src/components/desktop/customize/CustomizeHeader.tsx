'use client';

import type { CSSProperties } from 'react';
import type { ProjectRecord } from '../repo-registry/useProjects';
import { WorkspacePageHeader } from '../WorkspacePageHeader';

export type CustomizeTab = 'rules' | 'commands' | 'prompts' | 'skills' | 'plugins' | 'connections' | 'agents' | 'hooks';

const TABS: Array<{ id: CustomizeTab; label: string }> = [
  { id: 'plugins', label: 'Plugins' },
  { id: 'skills', label: 'Skills' },
  { id: 'rules', label: 'Instructions' },
  { id: 'commands', label: 'Commands' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'connections', label: 'Connections' },
  { id: 'agents', label: 'Agents' },
  { id: 'hooks', label: 'Hooks' },
];

const fieldStyle: CSSProperties = {
  minWidth: 0, minHeight: 42, border: '1px solid var(--t-divider)', borderRadius: 12,
  background: 'var(--t-input-bg)', color: 'var(--t-text)', font: 'inherit',
  paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
};

export function CustomizeHeader({ tab, onTab, query, onQuery, repos, scope, onScope, project, counts, onClose, pluginsOnly = false }: {
  tab: CustomizeTab;
  onTab: (tab: CustomizeTab) => void;
  query: string;
  onQuery: (query: string) => void;
  repos: Array<{ name: string; localPath: string }>;
  scope: string;
  onScope: (scope: string) => void;
  project?: ProjectRecord | null;
  counts: Partial<Record<CustomizeTab, number>>;
  onClose?: () => void;
  pluginsOnly?: boolean;
}) {
  const tabs = TABS;
  const label = tabs.find((item) => item.id === tab)?.label ?? 'customizations';
  const repoName = scope === 'personal' || !project ? 'Personal' : repos.find((repo) => repo.localPath === scope)?.name ?? project.name;
  const filtersRepositories = ['rules', 'skills', 'prompts', 'agents', 'hooks'].includes(tab);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <WorkspacePageHeader
        title={pluginsOnly ? 'Plugins' : 'Customize'}
        subtitle={project ? `${project.name} · ${project.repoPaths.length} ${project.repoPaths.length === 1 ? 'repository' : 'repositories'}` : 'Personal customizations'}
        onClose={onClose}
      />
      {!pluginsOnly ? <nav aria-label="Customization sections" style={{ display: 'flex', flexWrap: 'wrap', columnGap: 22, rowGap: 4, marginBottom: 24, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        {tabs.map((item) => (
          <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => onTab(item.id)} style={{
            minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6, paddingTop: 10, paddingBottom: 10,
            paddingLeft: 0, paddingRight: 0, border: 'none', borderRadius: 0, borderBottom: `2px solid ${tab === item.id ? 'var(--t-accent)' : 'transparent'}`,
            background: 'transparent', color: tab === item.id ? 'var(--t-text)' : 'var(--t-text-muted)',
            fontSize: 13, fontWeight: 300, fontFamily: 'inherit', cursor: 'pointer',
          }}>
            {item.label}
            {counts[item.id] || (item.id === 'rules' && counts.rules === 0) ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{counts[item.id]}</span> : null}
          </button>
        ))}
      </nav> : null}
      {tab !== 'plugins' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <input aria-label={`Search ${label}`} placeholder={`Search ${label} for ${repoName}…`} value={query} onChange={(event) => onQuery(event.target.value)}
            style={{ ...fieldStyle, flex: '1 1 200px', fontSize: 13 }} />
          {filtersRepositories ? <select aria-label="Customization view" value={scope} onChange={(event) => onScope(event.target.value)} style={{ ...fieldStyle, maxWidth: 260 }}>
              <option value="all">{project ? 'All project repositories + personal' : 'Personal'}</option>
              {project ? <option value="personal">Personal only</option> : null}
              {repos.map((repo) => <option key={repo.localPath} value={repo.localPath}>{repo.name} + personal</option>)}
            </select> : <span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Shared across projects</span>}
        </div>
      ) : null}
    </div>
  );
}
