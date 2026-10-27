export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { resolveDeviceByToken } from '@/lib/mobile/device-registry';
import {
  normalizeMobileAskModelId,
  resolveMobileAskRoute,
  type MobileAskEffort,
} from '@/lib/mobile/ask-model-routing';
import { readSymonAgentContext, resolveSymonAgentScope } from '@/lib/mobile/symon-agent-context';
import {
  type SymonTextPlannerSelection,
} from '@/lib/mobile/symon-text-eval';
import { createSymonTextSession } from '@/lib/mobile/symon-text-session-store';
import {
  readSymonTextPlannerInfo,
  type SymonTextPlannerInfo,
} from '@/lib/mobile/symon-text-bridge-client';
import { getRuntimeAuthSnapshotForClaudeCarrier } from '@/lib/runtimes/shared/auth-detect';
import { SYMON_MANAGED_MODEL } from '@/lib/symon/durable/managed-provider';
import { readSymonTextBrainMode } from '@/lib/symon/durable/text-brain-setting';

/** The planner selection a phone text session binds when the built-in Pi brain answers it (#3453). */
const PI_BRAIN_INFO: SymonTextPlannerInfo = {
  available: true,
  engine: 'pi',
  model: SYMON_MANAGED_MODEL.id,
  effort: 'default',
  allowDefaultFallback: false,
  tools: [],
};

function requestBearer(request: NextRequest): string {
  const auth = request.headers.get('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

async function resolveRequestedPlanner(value: unknown, effort?: MobileAskEffort): Promise<SymonTextPlannerSelection | null> {
  const requestedModel = normalizeMobileAskModelId(value);
  if ((requestedModel === 'auto' && effort === undefined) || requestedModel === 'managed-free') return null;
  try {
    // The Tauri planner launches the native CLI. Stored gateway readiness belongs to
    // packet workers and must not make this native-only surface selectable.
    const snapshot = await getRuntimeAuthSnapshotForClaudeCarrier('native');
    const claude = snapshot.statuses.claude;
    const codex = snapshot.statuses.codex;
    // `ready` is the usability verdict; `authenticated` is credential evidence only.
    // An inconclusive native probe leaves authenticated false while the house stays
    // dispatchable. This route explicitly derives the native-carrier view above.
    const readiness = {
      claude: claude.installed && claude.ready,
      codex: codex.installed && codex.ready,
    };
    const route = resolveMobileAskRoute(requestedModel, readiness, effort);
    if (route.kind === 'managed') throw new Error('The selected native planner is unavailable.');
    return {
      engine: route.kind,
      model: route.cliModel,
      effort: route.effort,
    };
  } catch {
    throw new Error('The selected native planner is unavailable. Choose another model explicitly.');
  }
}

export async function POST(request: NextRequest) {
  const principal = resolveRequestPrincipal(request);
  if (principal === 'worker') {
    return NextResponse.json(
      { ok: false, error: 'locked', detail: 'Symon text mode is not available to a dispatched worker.' },
      { status: 403 },
    );
  }
  if (principal !== 'operator' && principal !== 'device') {
    return NextResponse.json(
      { ok: false, error: 'unauthorized', detail: 'Symon text mode requires the operator credential or an enrolled device.' },
      { status: 401 },
    );
  }
  const device = principal === 'device' ? resolveDeviceByToken(requestBearer(request)) : null;
  if (principal === 'device' && !device) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized', detail: 'The enrolled phone identity could not be resolved.' },
      { status: 401 },
    );
  }

  const context = await readSymonAgentContext(request);
  if (context.invalidBody) {
    return NextResponse.json({ ok: false, error: 'invalid_body', detail: 'Invalid Ask request body.' }, { status: 400 });
  }
  if (context.invalidEffort) {
    return NextResponse.json({ ok: false, error: 'invalid_effort', detail: 'Invalid explicit Ask effort.' }, { status: 400 });
  }
  const scope = await resolveSymonAgentScope(context);
  if (!scope) {
    return NextResponse.json(
      { ok: false, error: 'invalid_repo', detail: 'Code mode requires an exact registered repository.' },
      { status: 400 },
    );
  }

  // The phone's model picker only lists the two proprietary CLIs. When it
  // names none of them, ask the native registry for the seat the operator's
  // Symon brain setting actually resolves — since #2176 the text surface binds
  // by registry id, so an open runtime seats it the same way. The availability
  // gate below reports the native side's own reason when there is no seat.
  //
  // The built-in Pi brain (#3453) answers when the operator chose it, when the
  // phone asks for the managed model, or, on auto, when no native planner is
  // reachable. An explicit native model pin is never replaced by it.
  const brainMode = readSymonTextBrainMode();
  const managedRequested = normalizeMobileAskModelId(context.model) === 'managed-free';
  if (context.effort !== undefined && (brainMode === 'pi' || managedRequested)) {
    return NextResponse.json({ ok: false, error: 'effort_unsupported', detail: 'This planner cannot honor an explicit effort pin.' }, { status: 400 });
  }
  let info: SymonTextPlannerInfo;
  if (brainMode === 'pi' || managedRequested) {
    info = PI_BRAIN_INFO;
  } else {
    let requestedPlanner: SymonTextPlannerSelection | null;
    try {
      requestedPlanner = await resolveRequestedPlanner(context.model, context.effort);
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: 'desktop_unavailable', detail: error instanceof Error ? error.message : 'Desktop bridge unavailable.' },
        { status: 503 },
      );
    }
    const piFallback = brainMode === 'auto' && !requestedPlanner;
    try {
      info = await readSymonTextPlannerInfo(requestedPlanner ?? undefined);
    } catch (error) {
      if (!piFallback) {
        return NextResponse.json(
          { ok: false, error: 'desktop_unavailable', detail: error instanceof Error ? error.message : 'Desktop bridge unavailable.' },
          { status: 503 },
        );
      }
      info = PI_BRAIN_INFO;
    }
    if (!info.available || !info.engine || !info.model || !info.effort) {
      if (!piFallback) {
        return NextResponse.json(
          { ok: false, error: 'no_cli', detail: info.detail || 'No supported Symon planner CLI is installed.' },
          { status: 501 },
        );
      }
      info = PI_BRAIN_INFO;
    }
  }
  if (!info.engine || !info.model || !info.effort) {
    return NextResponse.json({ ok: false, error: 'no_cli', detail: 'No supported Symon planner is available.' }, { status: 501 });
  }
  if (context.effort !== undefined && info.effort !== context.effort) {
    return NextResponse.json({ ok: false, error: 'effort_mismatch', detail: 'The planner did not honor the explicit effort pin.' }, { status: 409 });
  }
  const allowedTools = Array.from(new Set((info.tools ?? []).flatMap((tool) => {
    const name = tool.name;
    return typeof name === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(name) ? [name] : [];
  })));
  try {
    const session = createSymonTextSession({
      reattachable: process.env.O8_MANAGED_LIVE_ENABLED === '1' && new URL(request.url).searchParams.get('managedVoice') === '1',
      subject: principal,
      deviceId: device?.id ?? null,
      engine: info.engine,
      model: info.model,
      effort: info.effort,
      allowDefaultFallback: context.effort === undefined && info.allowDefaultFallback === true,
      workspaceMode: scope.workspaceMode,
      repoId: scope.repoId,
      repoPath: scope.repoPath,
      allowedTools,
    });
    return NextResponse.json({
      ok: true,
      session: {
        sessionId: session.sessionId,
        model: session.model,
        effort: session.effort,
        engine: session.engine,
        activeMachine: session.activeMachine,
      },
      scope: {
        version: 1,
        repoId: session.repoId,
        repoPath: session.repoPath,
        workspaceMode: session.workspaceMode,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'desktop_unavailable', detail: error instanceof Error ? error.message : 'Session persistence failed.' },
      { status: 503 },
    );
  }
}
