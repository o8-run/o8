'use client';

import { useEffect, useRef, useState } from 'react';
import { RuntimeConnectionSummary } from '../../onboarding/RuntimeConnectionSummary';
import { AcpModelPicker } from '../AcpModelPicker';
import { useRuntimeInventory } from '../../onboarding/useRuntimeInventory';
import { RuntimeToolsPanel } from '../../onboarding/RuntimeToolsPanel';
import { FloatingSurface } from '../../FloatingSurface';
import { enabledRuntimeInventory, runtimeForLead, visibleRuntimeInventory } from '@/lib/setup/runtime-recommendation';
import { findCatalogueModel, type CatalogueGroup } from '@/lib/orchestrator/acp-model-catalogue';
import { type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { type ComposerModelGroup, type ComposerModelOption } from '../ModelThinkingChip';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { ComposerPopover } from '../chat-panel/ComposerPopover';
import { providerMarkForLead, type ResolvedComposerSelectorState } from './state';
import { LeadChip } from './ComposerSelectorChips';
import { ThinkingChip } from './ThinkingChip';
import { ProviderMarkGlyph } from './provider-marks';
import { FavoriteGlyph, ModelPickerRow } from './ModelPickerRow';
import { useModelVisibility, openRouterModelKey } from './model-visibility';
import { modelFavoriteKey, readModelFavorites, useModelFavorites, type ModelFavorite } from './model-favorites';

interface House { id: string; label: string; ready: boolean; group?: ComposerModelGroup; runtime?: OrchestratorRuntime }
interface Pick { favorite: ModelFavorite; option?: ComposerModelOption; group?: ComposerModelGroup; runtime?: OrchestratorRuntime }

export function ComposerPicker({ state, composerModelGroups, onModelChange, onBackendChange, onEffortChange, onRequestTextareaFocus, onOpenChange, saving = false }: {
  state: ResolvedComposerSelectorState;
  composerModelGroups: ComposerModelGroup[];
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
  onRequestTextareaFocus?: () => void;
  onOpenChange?: (open: boolean) => void;
  saving?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [acpAvailable, setAcpAvailable] = useState(false);
  const { hidden: hiddenModels } = useModelVisibility();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch('/api/setup/orchestrator-backends').then(response => response.ok ? response.json() : null)
      .then(data => { if (alive) setAcpAvailable(data?.acp === true); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [houseId, setHouseId] = useState<string>('codex');
  const [query, setQuery] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leadRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const tools = useRuntimeInventory(open);
  const { favorites, toggleFavorite } = useModelFavorites('lead');
  const installed = enabledRuntimeInventory(visibleRuntimeInventory(tools.inventory ?? [], []), tools.disabled);
  const ready = (runtime: string | null) => tools.inventory?.some((item) => item.id === runtime && item.available) === true;
  const leadGroup = composerModelGroups.find((group) => group.key === state.leadBackend || group.options.some((option) => option.backend === state.leadBackend && option.model === state.leadModelId));
  const houses: House[] = composerModelGroups.filter((group) => group === leadGroup || group.key === 'o8' || (group.key === 'acp' && acpAvailable) || installed.some((item) => item.id === runtimeForLead(group.key)))
    .map((group) => ({ id: group.key, label: group.key === 'claude' ? 'Claude Code' : group.label, ready: group.key === 'o8' || (group.key === 'acp' ? acpAvailable : ready(runtimeForLead(group.key))), group }));
  const house = houses.find((item) => item.id === houseId);
  const connection = tools.inventory?.find(item => item.id === runtimeForLead(house?.id as OrchestratorBackendSetting ?? null, tools.inventory ?? []))?.connection;
  const searchable = house?.group?.searchable;
  const normalizedQuery = query.trim().toLowerCase();
  const choices: Pick[] = houses.flatMap(item => (item.group?.options ?? []).map(option => ({
    favorite: { house: option.backend, id: option.model ?? '', label: option.label }, option, group: item.group,
  })));
  const favoriteKeys = new Set(favorites.map(modelFavoriteKey));
  const picks = houseId === 'favorites' ? favorites.map(favorite => choices.find(pick => modelFavoriteKey(pick.favorite) === modelFavoriteKey(favorite))
    ?? { favorite, group: composerModelGroups.find(group => group.key === favorite.house) })
    : normalizedQuery ? choices : choices.filter(pick => pick.group?.key === houseId);
  const shownPicks = picks.filter(pick => !hiddenModels.includes(openRouterModelKey(pick.favorite.id)) || pick.favorite.id === state.leadModelId)
    .filter(pick => !normalizedQuery || `${pick.favorite.label} ${pick.favorite.id} ${pick.favorite.house}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => Number(favoriteKeys.has(modelFavoriteKey(b.favorite))) - Number(favoriteKeys.has(modelFavoriteKey(a.favorite))));
  const isSelected = (pick: Pick) => pick.favorite.house === state.leadBackend && pick.favorite.id === state.leadModelId;

  const close = () => { generation.current += 1; setOpen(false); setPending(null); setError(null); setQuery(''); onOpenChange?.(false); };
  const toggle = () => {
    if (open) { close(); return; }
    generation.current += 1;
    setThinkingOpen(false);
    setHouseId(readModelFavorites('lead').length > 0 ? 'favorites' : leadGroup?.key ?? 'codex');
    setQuery(''); setPending(null); setError(null); setToolsOpen(false); setOpen(true); onOpenChange?.(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };
  const commit = (pick: Pick) => {
    if (pick.favorite.house === state.leadBackend && onModelChange) onModelChange(pick.favorite.id);
    else onBackendChange?.(pick.favorite.house as OrchestratorBackendSetting, pick.favorite.id);
    close(); onRequestTextareaFocus?.();
  };
  const select = async (pick: Pick) => {
    const source = houses.find(item => item.id === pick.group?.key);
    if (saving || pending || !source?.ready) return;
    const version = ++generation.current;
    setPending(modelFavoriteKey(pick.favorite)); setError(null);
    try {
      if (!pick.option) {
        const response = await fetch(`/api/orchestrator/backend-models?backend=${encodeURIComponent(pick.favorite.house)}`, { cache: 'no-store' });
        const data = await response.json() as { groups?: CatalogueGroup[]; available?: boolean; error?: string };
        if (generation.current !== version) return;
        if (!response.ok || data.available === false || data.error || !findCatalogueModel(data.groups ?? [], pick.favorite.id)) {
          setError('This favorite is unavailable. Open its house to choose a current model.'); return;
        }
      }
      commit(pick);
    } catch (failure) {
      if (generation.current === version) setError(failure instanceof Error ? failure.message : 'Could not check this model. Try its house again.');
    } finally { if (generation.current === version) setPending(null); }
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (!event.defaultPrevented && event.key === 'Escape') {
      event.preventDefault(); close(); onRequestTextareaFocus?.(); return;
    }
    if (event.defaultPrevented || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    const rows = [...(contentRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-choice]:not(:disabled)') ?? [])];
    if (!rows.length) return;
    if (event.key === 'Enter') {
      if (event.target instanceof HTMLInputElement) { event.preventDefault(); rows[0]?.click(); }
      return;
    }
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  const pickerOpen = open;
  return <>
    <LeadChip state={state} open={pickerOpen} saving={saving} buttonRef={leadRef} onClick={() => toggle()} />
    <ThinkingChip state={state} saving={saving} onPick={onEffortChange} open={thinkingOpen} onOpenChange={(next) => { if (next) close(); setThinkingOpen(next); }} />
    <ComposerPopover anchorRef={leadRef} open={pickerOpen} onClose={close} align="end">
      <FloatingSurface data-testid="composer-selector-popover" role="dialog" aria-label={'Orchestrator models'} style={{ width: 366, maxWidth: 'calc(100vw * var(--zoom-inverse, 1) - 32px)', borderRadius: 18, overflowY: 'hidden' }} contentStyle={{ display: 'flex', maxHeight: 'min(470px, calc(100vh * var(--zoom-inverse, 1) - 72px))', overflow: 'hidden' }}>
        <div role="toolbar" aria-label={'Orchestrator houses'} aria-orientation="vertical" style={{ width: 44, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8, paddingRight: 5, paddingBottom: 8, paddingLeft: 5, borderRight: '1px solid var(--t-border)', overflowY: 'auto', scrollbarWidth: 'none' }}>
          <HouseButton label="Favorites" selected={houseId === 'favorites'} onClick={() => { generation.current += 1; setHouseId('favorites'); setQuery(''); setError(null); setPending(null); }} onRight={() => contentRef.current?.querySelector('input')?.focus()}><FavoriteGlyph filled={houseId === 'favorites'} /></HouseButton>
          {houses.map((item) => <HouseButton key={item.id} label={item.label} testId={`lead-house-${item.id}`} selected={houseId === item.id} onClick={() => { generation.current += 1; setHouseId(item.id); setQuery(''); setError(null); setPending(null); }} onRight={() => contentRef.current?.querySelector('input')?.focus()}>
            <ProviderMarkGlyph mark={providerMarkForLead(item.group!.options[0]?.backend ?? item.id as OrchestratorBackendSetting, item.group!.options[0]?.model ?? item.id)} size={17} />
          </HouseButton>)}
        </div>
        <div ref={contentRef} onKeyDown={keyDown} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingTop: 8, paddingRight: 6, paddingBottom: 6, paddingLeft: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24, paddingRight: 8, paddingLeft: 8, fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' }}><span>Orchestrator</span><span>{houseId === 'favorites' ? 'Favorites' : house?.label}</span></div>
          {house && !['acp', 'o8'].includes(house.id) ? <div style={{ paddingTop: 4, paddingRight: 8, paddingBottom: 8, paddingLeft: 8 }}><RuntimeConnectionSummary connection={connection} /></div> : null}
          {house?.id === 'acp' ? <ModelPickerRow label="Use agent default" testId="lead-acp-default" selected={state.leadBackend === 'acp' && !state.leadModelId} disabled={!house.ready || saving || Boolean(pending)} onSelect={() => { void commit({ group: house.group, favorite: { house: 'acp', id: '', label: 'Agent default' } }); }} /> : null}
          {searchable && house ? <AcpModelPicker key={house.id} backend={house.id} width={310} embedded defaultProvider={house.id === 'muse' ? 'meta' : 'openrouter'} allowEffortVariants favorites={favorites.filter(favorite => favorite.house === house.id)} onToggleFavorite={toggleFavorite} value={state.leadModelId} disabled={saving || Boolean(pending) || !house.ready}
            onSelect={(id) => { void select({ favorite: { house: house.id, id, label: id }, group: house.group }); }} /> : <>
            <input ref={searchRef} data-testid="composer-selector-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={houseId === 'favorites' ? 'Search favorites' : 'Search models'} aria-label="Search models" autoComplete="off" style={{ boxSizing: 'border-box', width: '100%', minHeight: 30, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, marginBottom: 4, borderWidth: 0, borderBottom: '1px solid var(--t-border)', background: 'transparent', outline: 'none', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300 }} />
            <div data-testid="composer-selector-lead-scroll" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none', maxHeight: 320 }}>
              {shownPicks.map((pick) => <ModelPickerRow key={modelFavoriteKey(pick.favorite)} testId={`lead-row-${pick.favorite.id || pick.runtime}`} label={pick.favorite.label} detail={pick.group?.key === 'o8' ? pick.option?.sub : houseId === 'favorites' || normalizedQuery ? pick.group?.label : undefined} selected={isSelected(pick)} disabled={saving || Boolean(pending) || !houses.find(item => item.id === pick.group?.key)?.ready} favorite={favoriteKeys.has(modelFavoriteKey(pick.favorite))} onFavorite={pick.favorite.id ? () => toggleFavorite(pick.favorite) : undefined} onSelect={() => { void select(pick); }} />)}
              {!shownPicks.length ? <div style={{ padding: 12, fontSize: 11, color: 'var(--t-text-muted)' }}>{houseId === 'favorites' && !query ? 'Star a model to keep it here.' : 'No models match this search.'}</div> : null}
            </div>
          </>}
          {pending ? <div role="status" style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>Applying selection…</div> : null}
          {error ? <div role="status" style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>{error}</div> : null}
          <button type="button" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 27, flexShrink: 0, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, marginTop: 4, borderWidth: 0, borderTop: '1px solid var(--t-border)', background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, cursor: 'pointer' }}><span>Coding tools</span><span>{toolsOpen ? '−' : '+'}</span></button>
          {toolsOpen ? <div style={{ overflowY: 'auto', scrollbarWidth: 'none', maxHeight: 130 }}><RuntimeToolsPanel inventory={tools.inventory} loading={tools.loading} error={tools.error} onRefresh={tools.refresh} /></div> : null}
        </div>
      </FloatingSurface>
    </ComposerPopover>
  </>;
}

function HouseButton({ label, testId, selected, onClick, onRight, children }: { label: string; testId?: string; selected: boolean; onClick: () => void; onRight: () => void; children: React.ReactNode }) {
  return <button data-testid={testId} type="button" title={label} aria-label={label} aria-pressed={selected} onClick={onClick}
    onKeyDown={(event) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); onRight(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = buttons.indexOf(event.currentTarget);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}
    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, flexShrink: 0, padding: 0, borderWidth: 0, borderRadius: 9, background: selected ? 'var(--t-accent-soft)' : 'transparent', color: selected ? 'var(--t-accent)' : 'var(--t-text-muted)', cursor: 'pointer' }}>{children}</button>;
}
