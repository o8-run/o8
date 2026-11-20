import 'server-only';

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { serializeProjectsLedgerMutation, writeProjectsLedgerAtomically } from './projects-ledger-writer';
import { getDataDir } from '@/lib/data-dir-migration';

const PROJECTS_PATH = path.join(getDataDir(), 'projects.json');

interface StoredProject {
  repoPaths?: unknown;
  [key: string]: unknown;
}

interface StoredProjectsLedger {
  projects?: unknown;
  [key: string]: unknown;
}

function normalizeRepoPath(inputPath: string) {
  return path.resolve(inputPath.trim().replace(/^~(?=\/|$)/, os.homedir()));
}

async function mutateProjectPaths(transform: (repoPath: string) => string | null) {
  return serializeProjectsLedgerMutation(async () => {
    let ledger: StoredProjectsLedger;
    try {
      ledger = JSON.parse(await readFile(PROJECTS_PATH, 'utf8')) as StoredProjectsLedger;
    } catch {
      return;
    }
    if (!Array.isArray(ledger.projects)) return;

    let changed = false;
    const projects = ledger.projects.map((project) => {
      if (!project || typeof project !== 'object' || !Array.isArray((project as StoredProject).repoPaths)) return project;
      let projectChanged = false;
      const stored = project as StoredProject;
      const current = stored.repoPaths as unknown[];
      const repoPaths = current.flatMap((candidate) => {
        if (typeof candidate !== 'string') return [candidate];
        const next = transform(candidate);
        if (next === candidate) return [candidate];
        changed = true;
        projectChanged = true;
        return next ? [next] : [];
      });
      const deduplicated = Array.from(new Set(repoPaths));
      if (deduplicated.length !== repoPaths.length) {
        changed = true;
        projectChanged = true;
      }
      return projectChanged ? { ...stored, repoPaths: deduplicated } : project;
    });

    if (changed) await writeProjectsLedgerAtomically(JSON.stringify({ ...ledger, projects }, null, 2));
  });
}

export async function removeRepoPathFromProjects(repoPath: string): Promise<void> {
  const target = normalizeRepoPath(repoPath);
  await mutateProjectPaths((candidate) => (normalizeRepoPath(candidate) === target ? null : candidate));
}

export async function repointRepoPathInProjects(previousRepoPath: string, nextRepoPath: string): Promise<void> {
  const previous = normalizeRepoPath(previousRepoPath);
  const next = normalizeRepoPath(nextRepoPath);
  await mutateProjectPaths((candidate) => (normalizeRepoPath(candidate) === previous ? next : candidate));
}
