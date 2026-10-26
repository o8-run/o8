// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';
import { accountIdentity, type ClerkIdentitySource } from '@/lib/auth/account-identity';

const SNAPSHOT_IMAGE = 'https://img.clerk.com/sign-up-snapshot';
const SNAPSHOT_EMAIL = 'signup@example.invalid';
const GITHUB_IMAGE = 'https://img.clerk.com/github-current';
const GITHUB_EMAIL = 'current@example.invalid';

const mocks = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useUser: () => ({ isLoaded: true, isSignedIn: Boolean(mocks.user), user: mocks.user }),
  useClerk: () => ({ session: { getToken: async () => null }, user: mocks.user }),
  useSignIn: () => ({ signIn: null }),
}));
vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));
vi.mock('@/lib/auth/clerk-fetch-guard', () => ({ installTauriClerkFetchGuard: () => {} }));

function clerkUser(externalAccounts: NonNullable<ClerkIdentitySource['externalAccounts']>) {
  return {
    id: 'user_identity', fullName: 'Fixture User', username: null, imageUrl: SNAPSHOT_IMAGE,
    primaryEmailAddress: { emailAddress: SNAPSHOT_EMAIL }, externalAccounts, reload: async () => {},
  };
}

describe('desktop account identity', () => {
  it.each([
    ['a linked GitHub account', [{ provider: 'github', emailAddress: GITHUB_EMAIL, imageUrl: GITHUB_IMAGE }], GITHUB_EMAIL, GITHUB_IMAGE],
    ['no GitHub account', [{ provider: 'google', emailAddress: 'other@example.invalid', imageUrl: 'https://img.clerk.com/other' }], SNAPSHOT_EMAIL, SNAPSHOT_IMAGE],
    ['a GitHub account without image or email', [{ provider: 'oauth_github', emailAddress: '', imageUrl: null }], SNAPSHOT_EMAIL, SNAPSHOT_IMAGE],
  ])('uses the right photo and email for %s', (_name, accounts, email, avatarUrl) => {
    expect(accountIdentity(clerkUser(accounts))).toEqual({ email, avatarUrl });
  });

  describe('through the provider', () => {
    let provisioned: Record<string, unknown>[];

    beforeEach(() => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      provisioned = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        if (String(input).includes('/api/panel/auth/clerk-provision')) provisioned.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }));
    });

    afterEach(() => {
      mocks.user = null;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('shows and records the linked GitHub photo and email, not the sign-up snapshot', async () => {
      const errors = vi.spyOn(console, 'error');
      mocks.user = clerkUser([{ provider: 'github', emailAddress: GITHUB_EMAIL, imageUrl: GITHUB_IMAGE }]);
      const { O8AuthProvider, useO8Auth } = await import('@/components/auth/O8AuthProvider');
      let state: O8AuthState | null = null;
      const Probe = () => {
        const value = useO8Auth();
        useEffect(() => { state = value; }, [value]);
        return null;
      };
      const root = createRoot(document.createElement('div'));
      try {
        await act(async () => { root.render(createElement(O8AuthProvider, null, createElement(Probe))); });
        // Account startup loads its session module from an effect. Settle that
        // import inside act before asserting the resulting state and request.
        await act(async () => { await vi.dynamicImportSettled(); });
        expect(provisioned).toHaveLength(1);
        expect(state!.user).toMatchObject({ email: GITHUB_EMAIL, avatarUrl: GITHUB_IMAGE });
        expect(provisioned[0]).toMatchObject({ clerkUserId: 'user_identity', email: GITHUB_EMAIL, avatarUrl: GITHUB_IMAGE });
      } finally {
        await act(async () => { root.unmount(); });
      }
      expect(errors.mock.calls.filter(([message]) => String(message).includes('not wrapped in act'))).toEqual([]);
    });
  });
});
