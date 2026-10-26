'use client';

import { useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { ComposerPopover } from '../thoughts/chat-panel/ComposerPopover';
import { FloatingSurface } from '../FloatingSurface';
import { refreshProjectsFromExternalMutation, type ProjectRecord } from '../repo-registry/useProjects';
import { isVirtualRepoProjectId } from '@/lib/repos/virtual-project-id';
import { visibleProjectNavigationItems } from './project-navigation';
import { ProjectGlyph, ProjectIdentity } from './ProjectIdentity';
import { ProjectGroupDialog } from './ProjectGroupDialog';
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';
import type { RepositorySource } from './repository-source-actions';
import { ProjectRepositories } from './ProjectRepositories';
import { useTauriFileDrop } from '@/lib/hooks/use-tauri-file-drop';
import { droppedRepoPath } from '../repo-registry/repo-folder-drop';
import { isRepoUrl } from '../repo-registry/recent-repo-folders';

const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 34, paddingTop: 5, paddingRight: 9, paddingBottom: 5, paddingLeft: 9, border: 0, borderRadius: 9, color: 'var(--t-text)', background: 'transparent', cursor: 'pointer', textAlign: 'left' as const, fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300 };

export function ProjectsSwitcher({ projects, loading = false, activeProjectId, selectedRepoPath, registeredRepoByPath, onProjectSelect, onRepoSelect, onManageProjects, onAddRepo, onRepositoryConnected }: {
  projects: ProjectRecord[];
  loading?: boolean;
  activeProjectId: string | null;
  selectedRepoPath: string | null;
  registeredRepoByPath: Map<string, RepoRegistryEntry>;
  onProjectSelect: (project: ProjectRecord) => Promise<boolean>;
  onRepoSelect: (project: ProjectRecord, repoPath: string) => void;
  onManageProjects: () => void;
  onAddRepo: (localPath?: string) => void;
  onRepositoryConnected?: (repo: RepoRegistryEntry) => void | Promise<void>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const addAnchor = useRef<HTMLButtonElement>(null);
  useTauriFileDrop({ hostRef: addAnchor, onDrop: paths => {
    if (paths.length === 1) onAddRepo(paths[0]);
  } });
  const addInput = {
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const path = droppedRepoPath(event.dataTransfer);
      onAddRepo(path ?? undefined);
    },
    onPaste: (event: React.ClipboardEvent) => {
      const value = event.clipboardData.getData('text/plain').trim();
      if (isRepoUrl(value)) { event.preventDefault(); onAddRepo(value); }
    },
  };
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const selecting = useRef(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'new' | string | null>(null);
  const [source, setSource] = useState<RepositorySource | null>(null);
  const reduceMotion = useReducedMotion();
  const repos = [...registeredRepoByPath.values()];
  const visible = visibleProjectNavigationItems(projects, repos);
  const empty = !loading && !repos.length && !visible.some(project => project.id !== 'default' || project.repoPaths.length > 0);
  const current = visible.find((project) => project.id === activeProjectId) ?? visible[0];
  const members = current?.repoPaths.flatMap((path) => registeredRepoByPath.get(path) ? [registeredRepoByPath.get(path)!] : []) ?? [];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = visible.filter((project) => {
    const text = `${project.name} ${project.repoPaths.map((path) => registeredRepoByPath.get(path)?.name ?? path).join(' ')}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const choose = async (project: ProjectRecord) => {
    if (selecting.current) return;
    selecting.current = true; setBusy(true); setError('');
    try {
      if (!await onProjectSelect(project)) throw new Error('Could not switch projects. Try again.');
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not switch projects.'); }
    finally { selecting.current = false; setBusy(false); }
  };
  const openDialog = (id: string) => { setOpen(false); setDialog(id); };
  const openSource = (value: RepositorySource) => { setOpen(false); setSource(value); };
  const dialogProject = dialog && dialog !== 'new' ? projects.find((project) => project.id === dialog) : undefined;
  const hover = (event: React.MouseEvent<HTMLButtonElement>, active = false) => { event.currentTarget.style.background = active ? 'var(--t-hover)' : 'transparent'; };
  return <>
    {empty ? <div data-project-switcher style={{ paddingLeft: 8, paddingRight: 5 }}>
      <button ref={anchor} type="button" onClick={() => openDialog('new')} onMouseEnter={event => hover(event, true)} onMouseLeave={event => hover(event)} style={rowStyle}><ProjectGlyph kind="add" /><span>New project</span></button>
      <button {...addInput} ref={addAnchor} type="button" onClick={() => { addAnchor.current?.focus(); setOpen(false); onAddRepo(); }} onMouseEnter={event => hover(event, true)} onMouseLeave={event => hover(event)} style={rowStyle}><ProjectGlyph kind="folder" /><span>Add repository</span></button>
    </div> : <div data-project-switcher style={{ display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 8, paddingRight: 5 }}>
      <button ref={anchor} type="button" aria-label="Switch project" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) refreshProjectsFromExternalMutation(); setQuery(''); setError(''); setOpen((value) => !value); }} onMouseEnter={(event) => hover(event, true)} onMouseLeave={(event) => hover(event, open)} style={{ ...rowStyle, flex: 1, minWidth: 0, paddingLeft: 2, paddingRight: 4, minHeight: 32, background: open ? 'var(--t-hover)' : 'transparent' }}>
        <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0, width: 17, height: 17, transform: 'translateX(-2px)' }}><ProjectIdentity name={current?.name ?? 'Projects'} color={current?.color} size={17} /></span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.5 }}>{current?.name ?? 'Projects'}</span>
        {members.length > 1 ? <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{members.length}</span> : null}
        <span style={{ color: 'var(--t-text-faint)' }}><ProjectGlyph kind="chevron" size={13} /></span>
      </button>
      <button {...addInput} ref={addAnchor} type="button" aria-label="Add repository" disabled={busy} title="Add repository" onClick={() => { addAnchor.current?.focus(); setOpen(false); onAddRepo(); }} onMouseEnter={event => hover(event, true)} onMouseLeave={event => hover(event)} style={{ ...rowStyle, width: 28, minHeight: 28, padding: 6, color: 'var(--t-text-muted)' }}><ProjectGlyph kind="add" size={16} /></button>
    </div>}
    <ComposerPopover anchorRef={anchor} open={open} align="start" onClose={() => setOpen(false)}>
      <motion.div initial={reduceMotion ? false : { y: -4 }} animate={{ y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}>
        <FloatingSurface overlay data-mcp-scope="navigation-menu" style={{ width: 'min(300px, calc(100vw - 24px))', borderRadius: 16 }} contentStyle={{ padding: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 9, paddingRight: 9, height: 35, borderBottom: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-muted)', marginBottom: 4 }}>
            <ProjectGlyph kind="search" size={14} /><input aria-label="Search projects" placeholder="Search projects…" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.closest('[data-composer-overlay]')?.querySelector<HTMLElement>('[data-project-choice]')?.focus(); }
              if (event.key === 'Enter' && filtered.length === 1) { event.preventDefault(); void choose(filtered[0]); }
            }} style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12, outline: 'none' }} />
          </div>
          <div role="menu" aria-label="Projects" style={{ maxHeight: 'min(320px, calc(100vh - 190px))', overflowY: 'auto', scrollbarWidth: 'none' }}>
            <button type="button" role="menuitem" disabled={busy} onClick={() => { setOpen(false); onManageProjects(); }} onMouseEnter={(event) => hover(event, true)} onMouseLeave={(event) => hover(event)} style={{ ...rowStyle, color: 'var(--t-text-secondary)' }}><ProjectGlyph kind="folder" /><span>All projects</span></button>
            {filtered.map((project) => {
              const active = project.id === current?.id;
              const projectRepos = project.repoPaths.flatMap((path) => registeredRepoByPath.get(path) ? [registeredRepoByPath.get(path)!] : []);
              return <div key={project.id} style={{ display: 'flex', alignItems: 'center', borderRadius: 9, background: active ? 'var(--t-hover)' : 'transparent' }}>
                <button data-project-choice={project.id} type="button" role="menuitemradio" aria-checked={active} disabled={busy} onClick={() => { void choose(project); }} onMouseEnter={(event) => hover(event, true)} onMouseLeave={(event) => hover(event)} style={{ ...rowStyle, flex: 1, minWidth: 0, minHeight: 43 }}>
                  <ProjectIdentity name={project.name} color={project.color} />
                  <span style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span><span style={{ display: 'block', fontSize: 10, marginTop: 2, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectRepos.length > 1 ? projectRepos.map((repo) => repo.name).join(' · ') : projectRepos.length ? '1 repository' : 'No repositories yet'}</span></span>
                  {active ? <span style={{ color: 'var(--t-accent)' }}><ProjectGlyph kind="check" size={13} /></span> : null}
                </button>
                {!isVirtualRepoProjectId(project.id) && project.id !== 'default' ? <button type="button" role="menuitem" aria-label={`Organize ${project.name}`} title={`Organize ${project.name}`} disabled={busy} onClick={() => openDialog(project.id)} onMouseEnter={(event) => hover(event, true)} onMouseLeave={(event) => hover(event)} style={{ ...rowStyle, width: 28, minHeight: 28, padding: 6, marginRight: 4, color: 'var(--t-text-muted)' }}><ProjectGlyph kind="settings" size={14} /></button> : null}
              </div>;
            })}
            {!filtered.length ? <p style={{ paddingLeft: 9, fontSize: 12, color: 'var(--t-text-muted)' }}>No matching projects.</p> : null}
          </div>
          {error ? <p role="alert" style={{ fontSize: 11, lineHeight: 1.4, paddingLeft: 9, color: 'var(--t-text-secondary)' }}>{error}</p> : null}
          <div role="menu" aria-label="Project actions" style={{ borderTop: '1px solid var(--t-divider-subtle)', marginTop: 4, paddingTop: 4 }}><button type="button" role="menuitem" disabled={busy} onClick={() => openDialog('new')} onMouseEnter={(event) => hover(event, true)} onMouseLeave={(event) => hover(event)} style={rowStyle}><ProjectGlyph kind="add" /><span>New project</span></button>
            <button type="button" role="menuitem" onClick={() => openSource('github')} onMouseEnter={event => hover(event, true)} onMouseLeave={event => hover(event)} style={rowStyle}><ProjectGlyph kind="link" /><span>Connected repositories</span></button>
            <button type="button" role="menuitem" onClick={() => openSource('new')} onMouseEnter={event => hover(event, true)} onMouseLeave={event => hover(event)} style={rowStyle}><ProjectGlyph kind="add" /><span>New repository</span></button>
          </div>
        </FloatingSurface>
      </motion.div>
    </ComposerPopover>
    {members.length > 1 && current ? <ProjectRepositories repos={members} selectedRepoPath={selectedRepoPath}
      onSelect={path => onRepoSelect(current, path)} /> : null}
    {dialog ? <ProjectGroupDialog key={dialog} repos={repos} project={dialogProject} projectId={dialog === 'new' ? undefined : dialog} onClose={() => { setDialog(null); anchor.current?.focus(); }} onAddRepo={() => { addAnchor.current?.focus(); onAddRepo(); }} onSaved={async (saved) => {
      const record = { id: saved.id, name: saved.name, repoPaths: saved.repos.flatMap((link) => repos.find((repo) => repo.id === link.repoId)?.localPath ?? []), createdAt: String(saved.createdAt) };
      if (!await onProjectSelect(record)) throw new Error('Project saved. Could not open it; try again.');
    }} /> : null}
    {source ? <ConnectRepositoryDialog source={source} projects={projects} activeProjectId={activeProjectId} onClose={() => { setSource(null); addAnchor.current?.focus(); }} onConnected={async (repo, project) => {
      if (project && !await onProjectSelect(project)) throw new Error('Repository connected. Could not open the project; try again.');
      await onRepositoryConnected?.(repo);
    }} /> : null}
  </>;
}
