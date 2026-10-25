import 'server-only';

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity, type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { DeviceError, type DeviceController, type DeviceControllerRoster } from './types';
import { publishControllers, type ControllerSnapshot } from './controller-events';

/** Bound by the transport, never accepted from model-supplied tool arguments. */
export interface DeviceControllerContext { conversation: string; worker: string; pid: number }
export interface StoredController extends DeviceController {
  pid: number;
  identity: MetadataLockProcessIdentity;
}
export interface ControllerRow {
  active: StoredController | null;
  waiting: StoredController[];
  operation?: { id: string; pid: number; identity: MetadataLockProcessIdentity; kind?: 'operator-input'; helper?: { pid: number; identity: MetadataLockProcessIdentity } };
  error?: string;
  lastInput?: DeviceControllerRoster['lastInput'];
}
interface Authority { host: string; revision?: number; devices: Record<string, ControllerRow> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** A single host-local authority, shared by the Next server and worker transports. */
export function updateControllers<T>(root: string, work: (state: Authority) => T): T {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new Database(join(root, 'controllers.sqlite'));
  let changed: ControllerSnapshot | undefined;
  let committed = false;
  try {
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    const result = db.transaction(() => {
      const saved = db.prepare('SELECT value FROM authority WHERE id = 1').get() as { value: string } | undefined;
      const state: Authority = saved ? JSON.parse(saved.value) : { host: randomUUID(), devices: {} };
      const result = work(state);
      if (JSON.stringify(state) !== saved?.value) {
        state.revision = (state.revision ?? 0) + 1;
        changed = controllerSnapshot(state);
      }
      db.prepare('INSERT OR REPLACE INTO authority (id, value) VALUES (1, ?)').run(JSON.stringify(state));
      return result;
    }).immediate();
    committed = true; return result;
  } finally { db.close(); if (committed && changed) publishControllers(root, changed); }
}

export function controllerSnapshot(state: Authority): ControllerSnapshot {
  return { revision: state.revision ?? 0, controllers: Object.entries(state.devices).map(([deviceId, value]) => ({ deviceId,
    active: value.active ? publicController(value.active) : null, waiting: value.waiting.map(publicController),
    busy: Boolean(value.operation), operatorInput: value.operation?.kind === 'operator-input',
    ...(value.error ? { error: value.error } : {}), ...(value.lastInput ? { lastInput: value.lastInput } : {}),
  })) };
}

export async function controllerFor(root: string, deviceId: string, context: DeviceControllerContext): Promise<StoredController> {
  if (!context.conversation || context.conversation.length > 256 || !/^[a-zA-Z0-9_-]{1,128}$/.test(context.worker)
    || !Number.isSafeInteger(context.pid) || context.pid <= 0) {
    throw new DeviceError('device_identity_required', 'Reconnect this worker to assign its device controller.', 409);
  }
  const probe = await probeMetadataLockProcessIdentity(context.pid);
  if (probe.state !== 'live') throw new DeviceError('device_worker_unavailable', 'The controller worker is no longer available.', 409);
  return updateControllers(root, state => {
    const conversation = digest(context.conversation).slice(0, 8);
    const worker = digest(context.worker).slice(0, 8);
    return { session: `o8-${digest(JSON.stringify([state.host, context.conversation, context.worker, probe.identity, deviceId])).slice(0, 32)}`,
      label: `Conversation ${conversation} · Worker ${worker}`, kind: 'worker', pid: context.pid, identity: probe.identity };
  });
}

export async function controllerAlive(controller: Pick<StoredController, 'pid' | 'identity'>): Promise<boolean | null> {
  const probe = await probeMetadataLockProcessIdentity(controller.pid);
  return probe.state === 'unknown' ? null : probe.state === 'live' && sameMetadataLockProcessIdentity(probe.identity, controller.identity);
}

export async function operationIdentity(): Promise<{ pid: number; identity: MetadataLockProcessIdentity }> {
  const probe = await probeMetadataLockProcessIdentity(process.pid);
  if (probe.state !== 'live') throw new DeviceError('device_authority_unavailable', 'Device authority could not verify its process. Retry shortly.', 409);
  return { pid: process.pid, identity: probe.identity };
}

export function publicController(controller: StoredController): DeviceController {
  return { session: controller.session, label: controller.label, kind: controller.kind };
}
