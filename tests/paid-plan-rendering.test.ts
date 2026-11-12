// @vitest-environment jsdom

import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountTab from '@/app/voice-settings/tabs/AccountTab';
import { AccountTab as DesktopAccountTab } from '@/components/desktop/settings/AccountTab';
import { AccountBlock } from '@/components/desktop/account-block/AccountBlock';
import { GeneralTab } from '@/components/desktop/settings/GeneralTab';
import { SettingsPage } from '@/components/desktop/SettingsPage';
import type { Plan } from '@/lib/entitlement/types';

// Icons are decorative; keep the real Account tab and its button primitives.
vi.mock('@/app/voice-settings/icons', () => ({
  ICONS: { user: () => null, gear: () => null },
  Icon: () => null,
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.0.0') }));
const authState = vi.hoisted(() => ({ signedIn: false }));
vi.mock('@/components/auth/O8AuthProvider', () => ({
  useO8Auth: () => ({
    clerkEnabled: false, isLoaded: true, signedIn: authState.signedIn,
    user: authState.signedIn ? { id: 'user_fixture', name: 'Account' } : null,
  }),
}));
vi.mock('@/lib/theme/context', () => ({
  useTheme: () => ({ paletteId: 'light', surface: {}, workspaceGlass: false }),
}));
vi.mock('@/components/desktop/dictation/SymonMachineControl', () => ({
  SymonMachineControl: () => null, SymonOrbStatusLine: () => null,
  useSymonOrbMinimized: () => true,
}));
vi.mock('@/components/desktop/settings/operator-defaults-client', () => ({
  fetchOperatorDefaults: async () => Response.json({ values: {}, envLocked: {} }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  authState.signedIn = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function respondWithPlan(plan: Plan, actualPlan: Plan = plan) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      plan, actualPlan, overrideActive: actualPlan !== plan,
      founder: plan === 'founder' ? { operatorNumber: 7, tier: null } : null,
    }),
  })));
}

describe('free edition through rendered app entry points', () => {
  const surfaces: Array<{ name: string; Component: ComponentType }> = [
    { name: 'voice Account', Component: AccountTab },
    { name: 'desktop Account', Component: DesktopAccountTab },
    { name: 'sidebar Account', Component: AccountBlock },
    { name: 'General', Component: GeneralTab },
    { name: 'Settings shell', Component: SettingsPage },
  ];
  it.each(surfaces)('renders $name without commercial copy or links', async ({ Component }) => {
    authState.signedIn = true;
    respondWithPlan('founder');
    await act(async () => root.render(createElement(Component)));
    expect(container.textContent).not.toMatch(/free plan|upgrade|pricing|lifetime|billing|founder|one-time purchase/i);
    expect(container.querySelector('a[href*="pricing"]')).toBeNull();
    expect(container.querySelector('[title*="No. 007"]')).toBeNull();
  });
});
