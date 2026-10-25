'use client';

import { useState } from 'react';
import { RetainedMemory } from './RetainedMemory';
import { ForgetMemoryButton } from '../ForgetMemoryButton';
import { RamsButton } from '../settings/shared';
import { indexedDocumentationSource, isIndexedDocumentation, type DirectiveSummary } from './inventory';
import { DetailLine, EmptyState, OpenFileLink, Row, SectionHeader, TruncatedRows } from './shared';

interface InstructionRowsProps {
  directives: DirectiveSummary[];
  expandedRow: string | null;
  onToggleRow: (id: string | null) => void;
  onOpenFile: (path: string) => void;
}

function InstructionRow({ directive: d, expandedRow, onToggleRow, onOpenFile }: Omit<InstructionRowsProps, 'directives'> & { directive: DirectiveSummary }) {
  const indexed = isIndexedDocumentation(d);
  return (
    <Row
      title={d.title}
      subtitle={`${d.repoName ? `${d.repoName} · ` : ''}${d.body.replace(/\s+/g, ' ').slice(0, 160)}`}
      pill={indexed ? 'Indexed reference' : d.scope === 'project' ? 'Project rule' : d.repoName ? 'Repository rule' : 'Shared rule'}
      expanded={expandedRow === d.id}
      onClick={() => onToggleRow(expandedRow === d.id ? null : d.id)}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {indexed ? <DetailLine label="Source" value={indexedDocumentationSource(d)} /> : null}
        <div style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.55, color: 'var(--t-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {d.body}
        </div>
        {d.file ? <OpenFileLink file={d.file} onOpenFile={onOpenFile} /> : null}
        <ForgetMemoryButton key={d.id} kind="directive" id={d.id} label={d.title} />
      </div>
    </Row>
  );
}

const REFERENCE_PAGE_SIZE = 20;

function IndexedDocumentation({ directives, ...rowProps }: InstructionRowsProps) {
  const [source, setSource] = useState('');
  const [page, setPage] = useState(0);
  const sources = [...new Set(directives.map(indexedDocumentationSource))].sort();
  const selectedSource = sources.includes(source) ? source : '';
  const selected = selectedSource ? directives.filter((d) => indexedDocumentationSource(d) === selectedSource) : directives;
  const lastPage = Math.max(0, Math.ceil(selected.length / REFERENCE_PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * REFERENCE_PAGE_SIZE;
  const changePage = (next: number) => { setPage(next); rowProps.onToggleRow(null); };

  return (
    <section aria-label="Indexed documentation">
      <SectionHeader label="Indexed documentation" count={directives.length} />
      <p style={{ marginTop: 0, marginBottom: 12, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-muted)' }}>
        Document sections indexed for retrieval. Browse by source or search their contents above.
      </p>
      <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t-text-muted)', marginBottom: 12 }}>
        Source
        <select aria-label="Documentation source" value={selectedSource} onChange={(event) => { setSource(event.target.value); changePage(0); }} style={{
          maxWidth: '100%', minWidth: 0, minHeight: 42, border: '1px solid var(--t-divider)', borderRadius: 12,
          background: 'var(--t-input-bg)', color: 'var(--t-text)', font: 'inherit',
          paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
        }}>
          <option value="">All sources</option>
          {sources.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      {selected.slice(start, start + REFERENCE_PAGE_SIZE).map((directive) => (
        <InstructionRow key={directive.id} directive={directive} {...rowProps} />
      ))}
      <nav aria-label="Documentation pages" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
        <RamsButton variant="ghost" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>Previous sections</RamsButton>
        <span role="status" style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Sections {start + 1} to {Math.min(start + REFERENCE_PAGE_SIZE, selected.length)} of {selected.length}</span>
        <RamsButton variant="ghost" disabled={currentPage === lastPage} onClick={() => changePage(currentPage + 1)}>Next sections</RamsButton>
      </nav>
    </section>
  );
}

export function InstructionsTab({ directives, query, correctionRepoPaths, ...rowProps }: InstructionRowsProps & { query: string; correctionRepoPaths?: string[] }) {
  const q = query.toLowerCase();
  const references = directives.filter(isIndexedDocumentation);
  const authored = directives.filter((d) => !isIndexedDocumentation(d));
  const visible = directives.filter((d) => !q || [d.title, d.body, d.repoName, d.file,
    isIndexedDocumentation(d) ? indexedDocumentationSource(d) : null,
  ].some((field) => field?.toLowerCase().includes(q)));
  const visibleAuthored = visible.filter((d) => !isIndexedDocumentation(d));
  const visibleReferences = visible.filter(isIndexedDocumentation);
  const shared = visibleAuthored.filter((d) => !d.repoName);
  const repoScoped = visibleAuthored.filter((d) => d.repoName);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <p style={{ marginTop: 0, marginBottom: 12, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-muted)' }}>
        {authored.length} authored {authored.length === 1 ? 'instruction' : 'instructions'} · {references.length} indexed {references.length === 1 ? 'section' : 'sections'}
      </p>
      {visible.length === 0 ? <EmptyState
        title={query && directives.length > 0 ? 'No matching instructions' : 'No additional rules'}
        body={query && directives.length > 0
          ? `No instructions match “${query}”. Change or clear the search to see your rules.`
          : 'Rules appear here with their source and scope. Shared project instructions are managed separately in the project view.'}
      /> : null}
      {[{ label: 'Shared rules', entries: shared }, { label: 'Repository rules', entries: repoScoped }].map(({ label, entries }) => entries.length ? (
        <div key={label}>
          <SectionHeader label={label} count={entries.length} />
          <TruncatedRows rows={entries.map((directive) => <InstructionRow key={directive.id} directive={directive} {...rowProps} />)} />
        </div>
      ) : null)}
      {visibleReferences.length ? <IndexedDocumentation key={q} directives={visibleReferences} {...rowProps} /> : null}
      {(['correction', 'outcome'] as const).map(kind => <RetainedMemory key={JSON.stringify([kind, correctionRepoPaths, q])} kind={kind} query={query} repoPaths={correctionRepoPaths} />)}
    </div>
  );
}
