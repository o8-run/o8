import { snapshotCacheInvalidation } from '@/lib/snapshot-cache-invalidation';
import type { BrowserAttachmentSummary, BrowserInventorySnapshot } from '@/lib/browser/types';
import { getAttachedBrowserSummary } from '@/lib/browser/attachment-state';
import { getBrowserInventorySnapshot } from '@/lib/browser/inventory';
import { invalidateOwnedCodexFleetCache } from '@/lib/codex/owned';
import { invalidateCodexDiscoveredFleetCache } from '@/lib/codex/sessions';
import type { FleetSnapshot, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import { getWorkspaceReviewSnapshot, invalidateReviewSnapshotCache } from '@/lib/review/workspace';
import { getRuntimeInventorySnapshot, invalidateRuntimeInventoryCache } from '@/lib/runtime/inventory';
import { invalidateCommandCenterBootstrapBroker } from '@/lib/render/bootstrap';

export interface CommandCenterSnapshot {
  fleet: FleetSnapshot;
  review: WorkflowReviewSnapshot | null;
  browserInventory: BrowserInventorySnapshot;
  attachedBrowser: BrowserAttachmentSummary | null;
  reviewError?: string | null;
  browserError?: string | null;
}

const EMPTY_BROWSER_INVENTORY: BrowserInventorySnapshot = {
  generatedAt: '',
  sourceLabel: 'Browser inventory unavailable',
  surfaces: [],
};

const REVIEW_TTL_MS = 45_000;
const BROWSER_TTL_MS = 30_000;

let reviewCache: { value: WorkflowReviewSnapshot | null; error: string | null; cachedAt: number } | null = null;
let browserCache: { value: BrowserInventorySnapshot; error: string | null; cachedAt: number } | null = null;
let reviewInflight: { generation: number; promise: Promise<{ value: WorkflowReviewSnapshot | null; error: string | null }> } | null = null;
let browserInflight: { generation: number; promise: Promise<{ value: BrowserInventorySnapshot; error: string | null }> } | null = null;
let reviewGeneration = 0;
let browserGeneration = 0;

const sharedInvalidation = snapshotCacheInvalidation('command-center');

export function invalidateCommandCenterSnapshotCaches() {
  sharedInvalidation.publish();
  clearSnapshotCaches();
}

function clearSnapshotCaches() {
  invalidateOwnedCodexFleetCache();
  invalidateCodexDiscoveredFleetCache();
  invalidateRuntimeInventoryCache();
  invalidateReviewSnapshotCache();
  invalidateCommandCenterBootstrapBroker();
  reviewGeneration += 1;
  browserGeneration += 1;
  reviewCache = null;
  browserCache = null;
  reviewInflight = null;
  browserInflight = null;
}

async function getCachedReview(fresh = false) {
  const generation = reviewGeneration;
  if (!fresh && reviewCache && Date.now() - reviewCache.cachedAt < REVIEW_TTL_MS) {
    return { value: reviewCache.value, error: reviewCache.error };
  }

  if (!fresh && reviewInflight && reviewInflight.generation === generation) return reviewInflight.promise;

  const promise = getWorkspaceReviewSnapshot({ fresh })
    .then((snapshot) => ({ value: snapshot, error: null }))
    .catch((error: unknown) => ({
      value: null,
      error: error instanceof Error ? error.message : 'Unable to refresh workflow review',
    }))
    .then((result) => {
      if (generation === reviewGeneration) {
        reviewCache = { ...result, cachedAt: Date.now() };
      }
      return result;
    });

  reviewInflight = { generation, promise };
  return promise.finally(() => {
    if (reviewInflight?.promise === promise) {
      reviewInflight = null;
    }
  });
}

async function getCachedBrowserInventory(fresh = false) {
  const generation = browserGeneration;
  if (!fresh && browserCache && Date.now() - browserCache.cachedAt < BROWSER_TTL_MS) {
    return { value: browserCache.value, error: browserCache.error };
  }

  if (!fresh && browserInflight && browserInflight.generation === generation) return browserInflight.promise;

  const promise = getBrowserInventorySnapshot()
    .then((snapshot) => ({ value: snapshot, error: null }))
    .catch((error: unknown) => ({
      value: EMPTY_BROWSER_INVENTORY,
      error: error instanceof Error ? error.message : 'Unable to refresh browser inventory',
    }))
    .then((result) => {
      if (generation === browserGeneration) {
        browserCache = { ...result, cachedAt: Date.now() };
      }
      return result;
    });

  browserInflight = { generation, promise };
  return promise.finally(() => {
    if (browserInflight?.promise === promise) {
      browserInflight = null;
    }
  });
}

function syncCommandCenterSnapshotCaches() {
  if (sharedInvalidation.changed()) clearSnapshotCaches();
}

export async function getCommandCenterSnapshot(): Promise<CommandCenterSnapshot> {
  return getCommandCenterSnapshotWithOptions();
}

export async function getCommandCenterSnapshotWithOptions(
  options: { fresh?: boolean } = {},
): Promise<CommandCenterSnapshot> {
  syncCommandCenterSnapshotCaches();
  const fresh = options.fresh ?? false;
  const [fleet, reviewResult, browserResult] = await Promise.all([
    getRuntimeInventorySnapshot({ fresh }),
    getCachedReview(fresh),
    getCachedBrowserInventory(fresh),
  ]);

  return {
    fleet,
    review: reviewResult.value,
    browserInventory: browserResult.value,
    attachedBrowser: getAttachedBrowserSummary(),
    reviewError: reviewResult.error,
    browserError: browserResult.error,
  };
}
