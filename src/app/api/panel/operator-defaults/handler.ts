import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { changesSettingsWindow, forwardToSettingsWindowOwner, nextOwnsSettingsWindow, SETTINGS_WINDOW_OWNER_HOP, settingsWindowError } from '@/lib/operator/settings-window-owner';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { applyOperatorDefaultsToml, getOperatorDefaults, getOperatorDefaultsTomlState, OPERATOR_DEFAULTS_FALLBACK, updateOperatorDefaults } from '@/lib/operator/defaults';
import { assertRoutingTomlCompatibility } from '@/lib/operator/routing-compatibility';
import { withStoragePressurePolicyLock } from '@/lib/orchestrator/storage-pressure-policy-lock';
import { operatorDefaultsUpdateFailure } from '@/lib/settings/operator-defaults-error';
import { mergeNativeSettingsToml, readNativeSettings, updateNativeSettings } from '@/lib/settings/native-settings';
import { getDispatchableRuntimeAvailability, getRuntimeAuthSnapshot, invalidateRuntimeAuthCache } from '@/lib/runtimes/shared/auth-detect';
import { assertThreecodeWorkerModelAvailable } from '@/lib/runtimes/threecode-model-catalogue';
import { parseOperatorDefaultsToml } from '@/lib/settings/toml';
import { readBuiltInAgentRuntime, readOnboardingRuntimeSetup } from '@/lib/setup/built-in-agent-server';
import { response, operatorDefaultsPayload, operatorDefaultsValuesPayload, isRecord, isWorkerRuntimeList, workspaceStorageValidationError, normalizeUpdate, projectParam, postNativeScoped } from './handler-helpers';

export async function GET(request: Request) {
  if (nextOwnsSettingsWindow() && isNativeCortexReader() && request.headers.has(SETTINGS_WINDOW_OWNER_HOP)) {
    return response({ error: 'Window owner unavailable.' }, 503);
  }
  const query = new URL(request.url).searchParams;
  try {
    if (query.get('include') === 'presentation') {
      const { values } = await getOperatorDefaults();
      return response({ values: { presentationQuietMode: values.presentationQuietMode, notificationsReviewReady: values.notificationsReviewReady } });
    }
    if (query.get('include') === 'native') return response(await readNativeSettings(projectParam(query)));
    if (query.get('include') === 'setup-built-in') return response({ builtInAgent: await readBuiltInAgentRuntime() });
    if (query.get('refresh') === 'runtime') invalidateRuntimeAuthCache();
    if (query.get('include') === 'values') {
      const [data, settingsToml] = await Promise.all([
        getOperatorDefaults(),
        getOperatorDefaultsTomlState(),
      ]);
      return response(operatorDefaultsValuesPayload(data, settingsToml, await settingsWindowError()));
    }
    const [data, settingsToml, cliAuth] = await Promise.all([
      getOperatorDefaults(),
      getOperatorDefaultsTomlState(),
      getRuntimeAuthSnapshot(),
    ]);
    const dispatchableRuntimes = await getDispatchableRuntimeAvailability(cliAuth);
    if (query.get('include') === 'setup') {
      return response({ ...operatorDefaultsPayload(data, settingsToml, cliAuth, dispatchableRuntimes, await settingsWindowError()), ...await readOnboardingRuntimeSetup(data, dispatchableRuntimes) });
    }
    return response(operatorDefaultsPayload(data, settingsToml, cliAuth, dispatchableRuntimes, await settingsWindowError()));
  } catch (error) {
    console.error('[panel-operator-defaults] Failed to load operator defaults:', query.get('include') === 'native' ? 'Native settings unavailable.' : error);
    return response({ error: 'Failed to load operator defaults.' }, 500);
  }
}

export async function POST(request: Request, options: { acknowledgeOnly?: boolean } = {}) {
  if (nextOwnsSettingsWindow() && isNativeCortexReader() && await changesSettingsWindow(request)) {
    // A bad owner origin must fail closed instead of proxying back to ourselves.
    // Caller-supplied hop headers can only refuse a request, never grant one.
    if (request.headers.has(SETTINGS_WINDOW_OWNER_HOP)) return response({ error: 'Window owner unavailable.' }, 503);
    return forwardToSettingsWindowOwner(request);
  }
  const changeWindow = async <T>(enabled: boolean | undefined, save: () => Promise<T>) => enabled === undefined
    ? save() : (await import('@/lib/next/app-window')).changeNextWindowPreference(enabled, save);
  const query = new URL(request.url).searchParams;
  const native = query.get('include') === 'native';
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return response({ error: 'Invalid request body.' }, 400);
    }
    if (native && query.has('scope') && query.get('scope') !== 'global') return await postNativeScoped(query, body);
    const sourceUpdate = body.knowledgeSources ?? (typeof body.settingsToml === 'string' ? parseOperatorDefaultsToml(body.settingsToml).knowledgeSources : undefined);
    if ((sourceUpdate !== undefined || (body.settingsToml !== undefined && (await getOperatorDefaults()).values.knowledgeSources.length > 0)) && resolveRequestPrincipalContext(request).role !== 'operator') return response({ error: 'Knowledge sources require an operator credential.' }, 403);
    if (body.settingsToml !== undefined) {
      if (typeof body.settingsToml !== 'string') {
        return response({ error: 'settingsToml must be a string.' }, 400);
      }
      if (typeof body.settingsTomlRevision !== 'string' || !body.settingsTomlRevision) {
        return response({ error: 'settingsTomlRevision is required to save settings.toml.' }, 400);
      }
      if (native) body.settingsToml = await mergeNativeSettingsToml(body.settingsToml, body.settingsTomlRevision);
      assertRoutingTomlCompatibility(body.settingsToml as string, OPERATOR_DEFAULTS_FALLBACK);
      const tomlModel = parseOperatorDefaultsToml(body.settingsToml as string).threecodeWorkerModel;
      if (tomlModel) await assertThreecodeWorkerModelAvailable(tomlModel);
      const [updated, cliAuth] = await Promise.all([
        changeWindow(parseOperatorDefaultsToml(body.settingsToml as string).experimentalNext ?? false, () => (
          withStoragePressurePolicyLock(() => applyOperatorDefaultsToml(body.settingsToml as string, body.settingsTomlRevision as string))
        )),
        (native || options.acknowledgeOnly) ? null : getRuntimeAuthSnapshot(),
      ]);
      if (!cliAuth) return response({ ok: true });
      const [settingsToml, dispatchableRuntimes] = await Promise.all([
        getOperatorDefaultsTomlState(),
        getDispatchableRuntimeAvailability(cliAuth),
      ]);
      return response(operatorDefaultsPayload(updated, settingsToml, cliAuth, dispatchableRuntimes, await settingsWindowError()));
    }
    if (body.workerRuntimes !== undefined && !isWorkerRuntimeList(body.workerRuntimes)) {
      return response({ error: 'workerRuntimes must contain at least one dispatchable runtime.' }, 400);
    }
    const storageValidationError = workspaceStorageValidationError(body);
    if (storageValidationError) return response({ error: storageValidationError }, 400);

    const update = normalizeUpdate(body);
    if (Object.keys(update).length === 0) {
      return response({ error: 'No supported fields in request body.' }, 400);
    }
    if (update.threecodeWorkerModel) await assertThreecodeWorkerModelAvailable(update.threecodeWorkerModel);
    const [updated, cliAuth] = await Promise.all([
      changeWindow(update.experimentalNext, () => withStoragePressurePolicyLock(() => native ? updateNativeSettings(update, body.settingsTomlRevision) : updateOperatorDefaults(update))),
      (native || options.acknowledgeOnly) ? null : getRuntimeAuthSnapshot(),
    ]);
    if (!cliAuth) return response({ ok: true });
    const [settingsToml, dispatchableRuntimes] = await Promise.all([
      getOperatorDefaultsTomlState(),
      getDispatchableRuntimeAvailability(cliAuth),
    ]);
    return response(operatorDefaultsPayload(updated, settingsToml, cliAuth, dispatchableRuntimes, await settingsWindowError()));
  } catch (error) {
    const failure = operatorDefaultsUpdateFailure(error, native);
    console.error('[panel-operator-defaults] Failed to update operator defaults:', failure.body.error);
    return response(failure.body, failure.status);
  }
}
