/**
 * GET /api/worktrees/retention-usage
 *
 * Fail-closed logical-size and host-volume snapshot for registered worktree
 * roots. Existing count/bytes fields remain available when every measurement
 * is observed; unknown accounting returns structured telemetry with HTTP 503.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import path from 'node:path';

import { NextResponse, type NextRequest } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import { readPacketStorageAdmissionProjection } from '@/lib/orchestrator/storage-admission';
import { projectStoragePressurePolicy } from '@/lib/orchestrator/storage-pressure-policy';
import { listRepos } from '@/lib/repos/registry';
import {
  aggregateDirectoryStorage,
  measureHostVolume,
  type AggregatedStorageTelemetry,
  type DirectoryStorageTelemetry,
  type HostVolumeTelemetry,
  type StorageAccountingStatus,
} from '@/lib/worktree/storage-telemetry';
import {
  readStorageCategorySnapshot,
  type StorageCategoryUsage,
} from '@/lib/worktree/storage-categories';
import {
  resolveManagedWorktreeStorageTarget,
  resolveWorktreeRootLayout,
} from '@/lib/worktree/root-layout';
import { countWorkspaceSnapshotsByState } from '@/lib/worktree/snapshot-state';

interface RepoUsage {
  id: string;
  name: string;
  path: string;
  count: number | null;
  bytes: number | null;
  allocatedBytes: number | null;
  logicalBytes: number | null;
  observedCount: number;
  observedAllocatedBytes: number;
  observedLogicalBytes: number;
  accountingStatus: StorageAccountingStatus;
  unknownCountMeasurements: number;
  unknownAllocatedByteMeasurements: number;
  unknownLogicalByteMeasurements: number;
  errors: AggregatedStorageTelemetry['errors'];
  categories: {
    source: StorageCategoryUsage;
    dependency: StorageCategoryUsage;
    build: StorageCategoryUsage;
  };
}

interface MeasuredRepo {
  row: RepoUsage | null;
  measurements: DirectoryStorageTelemetry[];
}

function distinctHostVolumes(measurements: HostVolumeTelemetry[]): HostVolumeTelemetry[] {
  const distinct = new Map<string, HostVolumeTelemetry>();
  for (const measurement of measurements) {
    const key = measurement.volumeId ?? `unknown:${measurement.targetPath}`;
    if (!distinct.has(key)) distinct.set(key, measurement);
  }
  return [...distinct.values()];
}

function combineAccountingStatuses(
  left: StorageAccountingStatus,
  right: StorageAccountingStatus,
): StorageAccountingStatus {
  if (left === 'observed' && right === 'observed') return 'observed';
  if (left === 'unknown' && right === 'unknown') return 'unknown';
  return 'partial';
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const repos = await listRepos();
    const layouts = repos.map((repo) => ({
      repo,
      layout: resolveWorktreeRootLayout(repo.localPath),
    }));
    const hostTarget = layouts[0]?.layout.configuredRoot
      ?? resolveWorktreeRootLayout(process.cwd()).configuredRoot;
    const hostTargets = [...new Set([
      hostTarget,
      ...layouts.flatMap(({ layout }) => layout.bases),
    ].map((target) => path.resolve(target)))];
    let admissionTargets: string[] = [];
    try {
      admissionTargets = repos.map((repo) => resolveManagedWorktreeStorageTarget(repo.localPath, process.env, { create: false }));
    } catch {
      // An unavailable configured root must not fall back to the repository volume.
      admissionTargets = [];
    }
    const [hostMeasurements, categoryStorage, storageAdmission] = await Promise.all([
      Promise.all(hostTargets.map((target) => measureHostVolume(target))),
      readStorageCategorySnapshot(layouts.map(({ repo, layout }) => ({
        repositoryUuid: repo.id,
        bases: layout.bases,
      }))),
      readPacketStorageAdmissionProjection(admissionTargets),
    ]);
    const categoryReposById = new Map(
      categoryStorage.repos.map((repo) => [repo.repositoryUuid, repo] as const),
    );
    const missingCategoryRepo = layouts.find(({ repo }) => !categoryReposById.has(repo.id));
    if (missingCategoryRepo) {
      return NextResponse.json(
        { error: `Storage category snapshot omitted registered repository ${missingCategoryRepo.repo.id}.` },
        { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    const measuredRepos = layouts.map(({ repo, layout }): MeasuredRepo => {
      const categoryRepo = categoryReposById.get(repo.id)!;
      const measurements = categoryRepo.workspaceMeasurements;
      const usage = aggregateDirectoryStorage(measurements);
      const allAbsent = measurements.every((measurement) => measurement.presence === 'absent');
      if (allAbsent) return { row: null, measurements };
      return {
        row: {
          id: repo.id,
          name: repo.name ?? path.basename(repo.localPath),
          path: layout.primaryBase,
          count: usage.count,
          bytes: usage.allocatedBytes,
          allocatedBytes: usage.allocatedBytes,
          logicalBytes: usage.logicalBytes,
          observedCount: usage.observedCount,
          observedAllocatedBytes: usage.observedAllocatedBytes,
          observedLogicalBytes: usage.observedLogicalBytes,
          accountingStatus: usage.accountingStatus,
          unknownCountMeasurements: usage.unknownCountMeasurements,
          unknownAllocatedByteMeasurements: usage.unknownAllocatedByteMeasurements,
          unknownLogicalByteMeasurements: usage.unknownLogicalByteMeasurements,
          errors: usage.errors,
          categories: categoryRepo.categories,
        },
        measurements,
      };
    });

    const rows = measuredRepos.flatMap(({ row }) => row ? [row] : []);
    const fleet = aggregateDirectoryStorage(
      measuredRepos.flatMap(({ measurements }) => measurements),
    );
    const hostVolumes = distinctHostVolumes(hostMeasurements);
    const hostAccountingStatus = hostVolumes.every((host) => host.accountingStatus === 'observed')
      ? 'observed' as const
      : 'unknown' as const;
    const primaryHost = hostMeasurements[0]!;
    const workspaceAndHostStatus = combineAccountingStatuses(
      fleet.accountingStatus,
      hostAccountingStatus,
    );
    const accountingStatus = combineAccountingStatuses(
      workspaceAndHostStatus,
      categoryStorage.accountingStatus,
    );
    const measuredAt = new Date().toISOString();
    const storagePressure = {
      ...projectStoragePressurePolicy(repos),
      parkedWorkspaces: countWorkspaceSnapshotsByState('parked'),
      repositories: repos.map((repo) => ({
        id: repo.id,
        name: repo.name ?? path.basename(repo.localPath),
        parkingDisabled: Boolean(repo.storagePressureParkingDisabled),
      })),
    };
    const payload = {
      schema: 'o8/worktree-storage-telemetry/v1',
      measuredAt,
      accountingStatus,
      totalCount: fleet.count,
      totalBytes: fleet.allocatedBytes,
      totalAllocatedBytes: fleet.allocatedBytes,
      totalLogicalBytes: fleet.logicalBytes,
      totalGb: fleet.allocatedBytes === null
        ? null
        : fleet.allocatedBytes / 1024 / 1024 / 1024,
      observedCount: fleet.observedCount,
      observedAllocatedBytes: fleet.observedAllocatedBytes,
      observedLogicalBytes: fleet.observedLogicalBytes,
      unknownCountMeasurements: fleet.unknownCountMeasurements,
      unknownAllocatedByteMeasurements: fleet.unknownAllocatedByteMeasurements,
      unknownLogicalByteMeasurements: fleet.unknownLogicalByteMeasurements,
      hostAccountingStatus,
      hostFreeBytes: primaryHost.freeBytes,
      hostAvailableBytes: primaryHost.availableBytes,
      hostTotalBytes: primaryHost.totalBytes,
      hostVolume: primaryHost,
      hostVolumes,
      categoryStorage: {
        schema: categoryStorage.schema,
        measuredAt: categoryStorage.measuredAt,
        accountingStatus: categoryStorage.accountingStatus,
        freshness: categoryStorage.freshness,
        categories: categoryStorage.categories,
        repos: categoryStorage.repos.map((repo) => ({
          repositoryUuid: repo.repositoryUuid,
          categories: repo.categories,
        })),
      },
      storageAdmission,
      storagePressure,
      repos: rows,
    };

    if (accountingStatus !== 'observed') {
      return NextResponse.json(
        {
          ...payload,
          error: 'Worktree storage accounting is incomplete; unknown measurements were not converted to zero.',
        },
        { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to measure worktree usage.' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
