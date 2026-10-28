'use client';

import { useRef, type CSSProperties } from 'react';
import { FolderOpen } from '../lucide-shims';
import { GlassModal } from './shared';
import { ProjectButton, projectInputStyle } from '../agent-panel/project-ui';
import { useTauriFileDrop } from '@/lib/hooks/use-tauri-file-drop';
import { isRepoUrl } from './recent-repo-folders';
import { droppedRepoPath } from './repo-folder-drop';
import { useAddRepo, type AddRepoOptions } from './useAddRepo';

const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 36,
  paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10,
  border: 0, borderRadius: 9, background: 'transparent', color: 'var(--t-text)',
  textAlign: 'left', cursor: 'pointer', fontFamily: 'var(--font-sans-system)',
  fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px',
};

export function AddRepoDialog(options: AddRepoOptions) {
  const flow = useAddRepo(options);
  const hostRef = useRef<HTMLDivElement>(null);
  const { dragOver } = useTauriFileDrop({
    hostRef, disabled: !options.open || flow.busy,
    onDrop: paths => {
      if (paths.length === 1) void flow.submit(paths[0], 'path');
      else flow.setError('Choose one project folder at a time.');
    },
  });
  const existing = flow.repos.find(repo => repo.localPath.replace(/\/+$/, '') === flow.registrationValue.replace(/\/+$/, ''));
  const cloning = !existing && !flow.registered && isRepoUrl(flow.value);
  return <GlassModal open={options.open} onClose={flow.close} title="Add repository" width={480} popoverSurface>
    <div ref={hostRef} onDragOver={event => event.preventDefault()} onDrop={event => {
      event.preventDefault();
      if (flow.busy) return;
      const path = droppedRepoPath(event.dataTransfer);
      if (event.dataTransfer.files.length > 1) flow.setError('Choose one project folder at a time.');
      else if (path) void flow.submit(path, 'path');
      else flow.setError('This browser does not share folder paths. Choose a folder or paste its full path.');
    }} style={{ display: 'flex', flexDirection: 'column', gap: 16, outline: dragOver ? '2px solid var(--t-accent)' : undefined, borderRadius: 10 }}>
      <form onSubmit={event => { event.preventDefault(); void flow.submit(flow.value); }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input id="add-repo-path" aria-label="Folder path or Git URL" autoFocus
            value={flow.value} onChange={event => flow.changeValue(event.currentTarget.value)}
            placeholder="Folder path or Git URL" disabled={flow.busy}
            style={{ ...projectInputStyle, flex: 1, height: 38, fontSize: 13.5 }} />
          <ProjectButton onClick={() => { void flow.browse(); }} disabled={flow.busy}>
            <FolderOpen size={14} />Choose folder
          </ProjectButton>
        </div>
        {options.projects.filter(project => project.id !== 'default').length > 0 ? <select
          aria-label="Project" value={flow.projectId} disabled={flow.busy}
          onChange={event => flow.setProjectId(event.currentTarget.value)} style={projectInputStyle}>
          <option value="none">Workspace</option>
          {options.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select> : null}
        {flow.stage ? <div role="status" aria-live="polite" style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>{flow.stage}</div> : null}
        {flow.retryState ? <div role="status" aria-live="polite" style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>{flow.retryState}</div> : null}
        {flow.error ? <div role="alert" style={{ color: 'var(--t-danger)', fontSize: 12, lineHeight: 1.45 }}>{flow.error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <ProjectButton onClick={flow.close} disabled={flow.busy}>Cancel</ProjectButton>
          <ProjectButton primary onClick={() => { void flow.submit(flow.value); }} busy={flow.busy} disabled={!flow.registrationValue || flow.busy}>
            {flow.busy ? cloning ? 'Cloning…' : 'Opening…' : flow.retryState ? 'Retry' : cloning ? 'Clone and open' : 'Open'}
          </ProjectButton>
        </div>
      </form>
      {flow.recents.length ? <nav aria-label="Recent folders" style={{ display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 12, maxHeight: 260, overflowY: 'auto' }}>
        {flow.recents.map(folder => <button key={folder.localPath} type="button" disabled={flow.busy}
          title={folder.localPath} aria-label={`Open ${folder.name}`}
          onClick={() => { void flow.submit(folder.localPath, 'path'); }}
          onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }} style={rowStyle}>
          <FolderOpen size={14} style={{ flexShrink: 0, color: 'var(--t-text-muted)' }} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name}</span>
        </button>)}
      </nav> : null}
    </div>
  </GlassModal>;
}
