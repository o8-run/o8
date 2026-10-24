import 'server-only';

import { randomUUID } from 'node:crypto';
import { controllerAlive, controllerFor, operationIdentity, publicController, updateControllers, type ControllerRow, type DeviceControllerContext, type StoredController } from './controller-store';
import { runControllerHelper } from './controller-helper';
import { DeviceError, type DeviceControllerRoster } from './types';

function row(): ControllerRow { return { active: null, waiting: [] }; }
function busy(): never { throw new DeviceError('device_controller_busy', 'Device input is in flight. Wait before handing off control.', 409); }
function refused(): never { throw new DeviceError('device_controller_occupied', 'This device is occupied. Request an explicit handoff from its controller.', 409); }

export class DeviceControllers {
  constructor(private readonly root: string) {}

  private helper(deviceId: string, session: string, args: string[]): Promise<unknown> {
    const id = updateControllers(this.root, state => {
      const operation = state.devices[deviceId].operation;
      if (operation) delete operation.helper;
      return operation?.id;
    });
    return runControllerHelper(this.root, session, args, helper => {
      updateControllers(this.root, state => {
        const operation = state.devices[deviceId].operation;
        if (operation && operation.id === id) operation.helper = helper;
      });
    });
  }

  private async operation<T>(deviceId: string, prepare: (value: ControllerRow) => void, work: (value: ControllerRow) => Promise<T>): Promise<T> {
    const operation = { id: randomUUID(), ...await operationIdentity() };
    const captured = updateControllers(this.root, state => {
      const value = state.devices[deviceId] ??= row();
      if (value.operation) busy();
      prepare(value);
      value.operation = operation;
      return structuredClone(value);
    });
    try { return await work(captured); }
    catch (error) {
      updateControllers(this.root, state => {
        const value = state.devices[deviceId];
        if (value.operation?.id === operation.id) value.error = 'Control could not be confirmed. Retry release or handoff.';
      });
      throw error;
    } finally {
      updateControllers(this.root, state => {
        const value = state.devices[deviceId];
        if (value.operation?.id === operation.id) delete value.operation;
      });
    }
  }

  async roster(): Promise<DeviceControllerRoster[]> {
    const snapshot = updateControllers(this.root, state => structuredClone(state.devices));
    for (const [deviceId, saved] of Object.entries(snapshot)) {
      if (saved.operation && await controllerAlive(saved.operation) === false
        && saved.operation.helper && await controllerAlive(saved.operation.helper) === false) {
        updateControllers(this.root, state => {
          const value = state.devices[deviceId];
          if (value.operation?.id === saved.operation!.id) {
            delete value.operation;
            value.error = 'A previous input was interrupted. Release control before retrying.';
          }
        });
        delete saved.operation;
      }
      // Never infer abandonment from elapsed time or an unknown process probe.
      const staleWaiters = new Set<string>();
      for (const waiter of saved.waiting) if (await controllerAlive(waiter) === false) staleWaiters.add(waiter.session);
      updateControllers(this.root, state => {
        state.devices[deviceId].waiting = state.devices[deviceId].waiting.filter(waiter => !staleWaiters.has(waiter.session));
      });
      if (saved.operation || !saved.active || saved.active.kind === 'operator' || await controllerAlive(saved.active) !== false) continue;
      try {
        await this.operation(deviceId, value => { if (value.active?.session !== saved.active!.session) busy(); }, async () => {
          await this.helper(deviceId, saved.active!.session, ['close']);
          updateControllers(this.root, state => { state.devices[deviceId].active = null; delete state.devices[deviceId].error; });
        });
      } catch { /* Failed recovery retains ownership and exposes a safe recovery state. */ }
    }
    return updateControllers(this.root, state => Object.entries(state.devices).map(([deviceId, value]) => ({ deviceId,
      active: value.active ? publicController(value.active) : null, waiting: value.waiting.map(publicController),
      busy: Boolean(value.operation), ...(value.error ? { error: value.error } : {}), ...(value.lastInput ? { lastInput: value.lastInput } : {}),
    })));
  }

  async acquire(deviceId: string, context: DeviceControllerContext): Promise<void> {
    const controller = await controllerFor(this.root, deviceId, context);
    await this.roster();
    const occupied = updateControllers(this.root, state => {
      const value = state.devices[deviceId] ??= row();
      if (value.active?.session === controller.session) return false;
      if (value.active || value.operation) {
        if (!value.waiting.some(item => item.session === controller.session)) {
          if (value.waiting.length >= 32) throw new DeviceError('device_queue_full', 'The device controller queue is full. Retry later.', 409);
          value.waiting.push(controller);
        }
        return true;
      }
      return false;
    });
    if (occupied) refused();
    await this.operation(deviceId, value => {
      if (value.active && value.active.session !== controller.session) refused();
      // Reserve before opening; an uncertain helper result must keep its owner.
      value.active = controller;
      value.waiting = value.waiting.filter(item => item.session !== controller.session);
    }, async () => {
      await this.helper(deviceId, controller.session, ['open', '--platform', 'ios', '--udid', deviceId]);
      updateControllers(this.root, state => { delete state.devices[deviceId].error; });
    });
  }

  async handoff(deviceId: string, expectedSession: string | null, targetSession: string | null, operator: boolean, releaseOperator = false): Promise<void> {
    const operatorIdentity = await operationIdentity();
    await this.operation(deviceId, value => {
      if ((value.active?.session ?? null) !== expectedSession) refused();
      if (!operator && value.active?.kind !== 'worker') refused();
      if (targetSession && !value.waiting.some(item => item.session === targetSession)) {
        throw new DeviceError('device_handoff_target_missing', 'The waiting worker is no longer available. Refresh Devices.', 409);
      }
    }, async captured => {
      const target: StoredController | null = targetSession ? captured.waiting.find(item => item.session === targetSession)!
        : operator && !releaseOperator ? { session: `operator-${randomUUID()}`, label: 'Operator', kind: 'operator', ...operatorIdentity } : null;
      if (target?.kind === 'worker' && await controllerAlive(target) !== true) {
        throw new DeviceError('device_worker_unavailable', 'The waiting worker is no longer available.', 409);
      }
      if (captured.active?.kind === 'worker') await this.helper(deviceId, captured.active.session, ['close']);
      // Keep the target reserved if opening fails, so recovery never closes someone else.
      updateControllers(this.root, state => {
        const value = state.devices[deviceId];
        value.active = target;
        value.waiting = value.waiting.filter(item => item.session !== target?.session);
        if (operator && captured.active?.kind === 'worker' && !value.waiting.some(item => item.session === captured.active!.session)) value.waiting.push(captured.active);
        delete value.lastInput; delete value.error;
      });
      if (target?.kind === 'worker') await this.helper(deviceId, target.session, ['open', '--platform', 'ios', '--udid', deviceId]);
    });
  }

  async release(deviceId: string, context: DeviceControllerContext): Promise<void> {
    const controller = await controllerFor(this.root, deviceId, context);
    const waiting = updateControllers(this.root, state => {
      const value = state.devices[deviceId] ??= row();
      if (value.operation) busy();
      if (value.active?.session === controller.session) return false;
      value.waiting = value.waiting.filter(item => item.session !== controller.session);
      return true;
    });
    if (!waiting) await this.handoff(deviceId, controller.session, null, false);
  }

  async input(deviceId: string, context: DeviceControllerContext, action: string, args: string[], point?: { x: number; y: number }): Promise<unknown> {
    const controller = await controllerFor(this.root, deviceId, context);
    return this.operation(deviceId, value => {
      if (value.active?.session !== controller.session || value.error) refused();
    }, async () => {
      const result = await this.helper(deviceId, controller.session, args);
      updateControllers(this.root, state => { state.devices[deviceId].lastInput = { action, label: controller.label, at: Date.now(), ...point }; });
      return result;
    });
  }
}
