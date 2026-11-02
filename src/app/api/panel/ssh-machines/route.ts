export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isTrustedPanelRequest, requirePanelAuth } from '@/lib/panel/auth';
import { listRemoteTerminalSessions, listSavedSshMachines, remoteControlCommand, SavedMachineError } from '@/lib/panel/saved-ssh-machines';

function localAuth(req: NextRequest) {
  const authError = requirePanelAuth(req);
  if (authError) return authError;
  if (!isTrustedPanelRequest(req)) {
    return NextResponse.json({ error: { code: 'local_only', message: 'Saved machines are available in the local app only.' } }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authError = localAuth(req);
  if (authError) return authError;
  try {
    const machines = listSavedSshMachines();
    const machineId = req.nextUrl.searchParams.get('machine');
    if (!machineId) {
      return NextResponse.json({ schema: 'o8/panel/ssh-machines/v1', machines: machines.filter(machine => !machine.usageOnly).map(({ id, label, target, port, sshConfig, enabled }) => ({ id, label, target, port, sshConfig, enabled })) });
    }
    const machine = machines.find((item) => item.id === machineId);
    if (!machine) {
      return NextResponse.json({ error: { code: 'machine_not_found', message: 'Saved machine not found.' } }, { status: 404 });
    }
    const sessions = await listRemoteTerminalSessions(machine);
    return NextResponse.json({ schema: 'o8/panel/ssh-machine-sessions/v1', machine: { id: machine.id, label: machine.label }, sessions });
  } catch (error) {
    if (error instanceof SavedMachineError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ error: { code: 'machine_error', message: 'Saved machine request failed.' } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const authError = localAuth(req);
  if (authError) return authError;
  let body: { machineId?: unknown; sessionId?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: { code: 'invalid_args', message: 'Choose a saved machine and terminal.' } }, { status: 400 });
  }
  try {
    if (typeof body.machineId !== 'string' || typeof body.sessionId !== 'string') {
      return NextResponse.json({ error: { code: 'invalid_args', message: 'Choose a saved machine and terminal.' } }, { status: 400 });
    }
    const machine = listSavedSshMachines().find((item) => item.id === body.machineId);
    if (!machine) {
      return NextResponse.json({ error: { code: 'machine_not_found', message: 'Saved machine not found.' } }, { status: 404 });
    }
    const sessions = await listRemoteTerminalSessions(machine);
    if (!sessions.some((session) => session.id === body.sessionId)) {
      return NextResponse.json({ error: { code: 'terminal_not_found', message: 'That terminal is no longer on this machine. Refresh its list.' } }, { status: 404 });
    }
    return NextResponse.json({
      schema: 'o8/panel/ssh-machine-control/v1',
      machine: { id: machine.id, label: machine.label },
      sessionId: body.sessionId,
      command: remoteControlCommand(machine.id, body.sessionId),
    });
  } catch (error) {
    if (error instanceof SavedMachineError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ error: { code: 'machine_error', message: 'Saved machine request failed.' } }, { status: 500 });
  }
}
