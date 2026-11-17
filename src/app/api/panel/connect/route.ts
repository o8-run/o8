import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { localMachineName } from '@/lib/mobile/machine-name';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

import {
  deleteMachine,
  listMachines,
  registerMachine,
  type MachineDevice,
  type MachineRegistryClientOptions,
  type MachineRegistryError,
} from '@/lib/connect/machine-registry';
import { writeConnectAttachEnabled } from '@/lib/connect/attach-settings';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { readCachedEntitlement } from '@/lib/entitlement/license';

export const dynamic = 'force-dynamic';

let cachedAppVersion: string | null = null;

function appVersion(): string {
  if (cachedAppVersion !== null) return cachedAppVersion;
  try {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version?: unknown };
    cachedAppVersion = typeof packageJson.version === 'string'
      ? packageJson.version
      : 'unknown';
  } catch {
    cachedAppVersion = 'unknown';
  }
  return cachedAppVersion;
}

function registryOptions(request: Request): MachineRegistryClientOptions | null {
  const sessionToken = request.headers.get('x-clerk-session-token')?.trim();
  const licenseToken = readCachedEntitlement()?.licenseKey?.trim();
  const token = sessionToken || licenseToken;
  return token ? { token } : null;
}

function authRequired() {
  return NextResponse.json({
    ok: false,
    error: {
      code: 'auth_required',
      status: 401,
      message: 'Sign in to o8 on this desktop before connecting the machine.',
    },
    hint: 'Open o8, use the existing account sign-in flow, wait for entitlement sync, then rerun `o8 connect`.',
  });
}

function registryFailure(error: MachineRegistryError) {
  const hint = error.code === 'device_cap'
    ? 'Run `o8 disconnect` on a connected machine, then retry `o8 connect` here.'
    : error.code === 'auth_required'
      ? 'Open o8, sign in again, then rerun the command.'
      : null;
  return NextResponse.json({ ok: false, error, hint });
}

function currentMachine(devices: MachineDevice[], installId: string): MachineDevice | null {
  return devices.find((device) => device.installId === installId) ?? null;
}

function disableAttachAfterDisconnect(): void {
  try {
    writeConnectAttachEnabled(false);
  } catch (error) {
    console.warn(
      `[connect] could not persist attach-off after disconnect: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function POST(request: Request) {
  try {
    const options = registryOptions(request);
    if (!options) return authRequired();
    const installId = getOrCreateInstallId();
    const result = await registerMachine({
      installId,
      name: localMachineName(),
      platform: platform(),
      appVersion: appVersion(),
    }, options);
    if (!result.ok) return registryFailure(result.error);
    return NextResponse.json({
      ok: true,
      machineId: result.data.machineId,
      deviceCap: result.data.deviceCap,
      devices: result.data.devices,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: {
        code: 'connect_failed',
        status: 500,
        message: error instanceof Error ? error.message : String(error),
      },
      hint: null,
    });
  }
}

export async function GET(request: Request) {
  try {
    const options = registryOptions(request);
    if (!options) return authRequired();
    const installId = getOrCreateInstallId();
    const result = await listMachines(options);
    if (!result.ok) return registryFailure(result.error);
    return NextResponse.json({
      ok: true,
      currentMachineId: currentMachine(result.data, installId)?.machineId ?? null,
      devices: result.data,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: {
        code: 'connect_status_failed',
        status: 500,
        message: error instanceof Error ? error.message : String(error),
      },
      hint: null,
    });
  }
}

export async function DELETE(request: Request) {
  try {
    const options = registryOptions(request);
    if (!options) return authRequired();
    const installId = getOrCreateInstallId();
    const listed = await listMachines(options);
    if (!listed.ok) return registryFailure(listed.error);
    const machine = currentMachine(listed.data, installId);
    if (!machine) {
      disableAttachAfterDisconnect();
      return NextResponse.json({
        ok: true,
        machineId: null,
        disconnected: false,
        devices: listed.data,
      });
    }

    const deleted = await deleteMachine(machine.machineId, options);
    if (!deleted.ok) return registryFailure(deleted.error);
    disableAttachAfterDisconnect();
    return NextResponse.json({
      ok: true,
      machineId: machine.machineId,
      disconnected: true,
      devices: listed.data.filter((device) => device.machineId !== machine.machineId),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: {
        code: 'disconnect_failed',
        status: 500,
        message: error instanceof Error ? error.message : String(error),
      },
      hint: null,
    });
  }
}
