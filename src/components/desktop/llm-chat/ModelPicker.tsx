import { memo, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from '../lucide-shims';
import { createPortal } from 'react-dom';

import { THEME_ACCENT, THEME_ACCENT_SOFT, type ModelOption } from './shared';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { PLAN_USAGE_URL } from '@/lib/chatgpt-plan/types';

const RUNTIME_META: Record<string, { label: string; logo?: string; color: string }> = {
  'claude-code': { label: 'Claude Code', logo: '/logos/claude.png', color: '#e07a3a' },
  codex: { label: 'Codex', logo: '/logos/codex.webp', color: '#10a37f' },
  gemini: { label: 'Gemini CLI', color: '#4285f4' },
  opencode: { label: 'OpenCode 2', color: '#a855f7' },
};

const SECTION_HEADER = { paddingTop: 8, paddingRight: 12, paddingBottom: 4, paddingLeft: 12, fontSize: 10, fontWeight: 600, color: 'var(--t-text-faint)', textTransform: 'uppercase' as const, letterSpacing: '0.06em' };

function ModelPickerBase({
  disabled,
  models,
  onSelect,
  selected,
}: {
  disabled: boolean;
  models: ModelOption[];
  onSelect: (model: ModelOption) => void;
  selected: ModelOption;
}) {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState({ bottom: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (dropRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setDropPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  const cliModels = models.filter((m) => m.backend === 'cli');
  const apiModels = models.filter((m) => m.backend === 'api' && m.provider !== 'chatgpt');
  const planModels = models.filter((m) => m.provider === 'chatgpt');

  // Group CLI models by runtime
  const runtimeGroups: { runtime: string; meta: typeof RUNTIME_META[string]; models: ModelOption[] }[] = [];
  for (const m of cliModels) {
    const rt = m.cliRuntime ?? 'unknown';
    let group = runtimeGroups.find((g) => g.runtime === rt);
    if (!group) {
      group = { runtime: rt, meta: RUNTIME_META[rt] ?? { label: rt, color: '#888' }, models: [] };
      runtimeGroups.push(group);
    }
    group.models.push(m);
  }

  const select = (m: ModelOption) => { onSelect(m); setOpen(false); };

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (!disabled) setOpen((value) => !value); }}
        disabled={disabled}
        style={{ display: 'flex', alignItems: 'center', gap: 5, paddingTop: 5, paddingRight: 6, paddingBottom: 5, paddingLeft: 8, border: 'none', borderRadius: 8, background: open ? THEME_ACCENT_SOFT : 'transparent', color: open ? 'var(--t-text)' : 'var(--t-text-secondary)', fontSize: 13, fontWeight: 400, fontFamily: 'var(--font-sans-system)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, transition: 'color 150ms, background 150ms' }}
        onMouseEnter={(event) => {
          if (disabled || open) return;
          event.currentTarget.style.color = 'var(--t-text)';
          event.currentTarget.style.background = THEME_ACCENT_SOFT;
        }}
        onMouseLeave={(event) => {
          if (open) return;
          event.currentTarget.style.color = 'var(--t-text-secondary)';
          event.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: selected.color, flexShrink: 0 }} />
        {selected.label}
        <ChevronDown size={12} style={{ color: 'var(--t-text-muted)', marginLeft: 2, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
      </button>
      {selected.provider === 'chatgpt' ? <button type="button" onClick={() => openExternalUrl(PLAN_USAGE_URL)} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11, cursor: 'pointer', paddingTop: 0, paddingBottom: 0, paddingLeft: 8, paddingRight: 0 }}>Using ChatGPT plan · Manage usage</button> : null}

      {open ? createPortal(
        <div ref={dropRef} style={{ position: 'fixed', bottom: dropPos.bottom, right: dropPos.right, zIndex: 9999, minWidth: 260, maxHeight: 420, overflowY: 'auto', background: 'var(--t-popover-surface)', border: '1px solid var(--t-panel-border)', borderRadius: 12, boxShadow: 'var(--t-panel-shadow)', animation: 'llmFadeIn 100ms ease-out' }}>
          {runtimeGroups.map((group, gi) => (
            <div key={group.runtime}>
              <div style={{ ...SECTION_HEADER, display: 'flex', alignItems: 'center', gap: 5, paddingTop: gi === 0 ? 6 : 8, ...(gi > 0 ? { borderTop: '1px solid var(--t-divider-subtle)', marginTop: 2 } : {}) }}>
                {group.meta.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 12px bundled provider logo
                  <img src={group.meta.logo} alt="" width={12} height={12} style={{ display: 'block', objectFit: 'contain', flexShrink: 0, borderRadius: 2 }} />
                ) : (
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.meta.color, flexShrink: 0 }} />
                )}
                {group.meta.label}
              </div>
              {group.models.map((model) => (
                <ModelRow key={model.id} model={model} selected={selected} onSelect={select} />
              ))}
            </div>
          ))}
          {planModels.length > 0 ? <><div style={{ ...SECTION_HEADER, paddingTop: 8 }}>Using ChatGPT plan</div>{planModels.map((model) => <ModelRow key={model.id} model={model} selected={selected} onSelect={select} />)}</> : null}
          {apiModels.length > 0 ? (
            <>
              <div style={{ ...SECTION_HEADER, paddingTop: runtimeGroups.length > 0 ? 8 : 6, ...(runtimeGroups.length > 0 ? { borderTop: '1px solid var(--t-divider-subtle)', marginTop: 2 } : {}) }}>
                API Keys
              </div>
              {apiModels.map((model) => (
                <ModelRow key={model.id} model={model} selected={selected} onSelect={select} />
              ))}
            </>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function ModelRow({ model, onSelect, selected }: { model: ModelOption; onSelect: (m: ModelOption) => void; selected: ModelOption }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(model)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', paddingTop: 7, paddingRight: 12, paddingBottom: 7, paddingLeft: 16, border: 'none', background: model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent', color: 'var(--t-text)', fontSize: 13, fontFamily: 'var(--font-sans-system)', cursor: 'pointer', textAlign: 'left', transition: 'background 100ms' }}
      onMouseEnter={(event) => { event.currentTarget.style.background = THEME_ACCENT_SOFT; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent'; }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: model.color, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500 }}>{model.label}</div>
        <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{model.description}</div>
      </div>
      {model.id === selected.id ? <Check size={14} style={{ color: THEME_ACCENT }} /> : null}
    </button>
  );
}

export const ModelPicker = memo(ModelPickerBase);
