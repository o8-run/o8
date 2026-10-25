import {
  O8_RESERVED_PORTS,
} from '@/lib/panel/port-constants';

import {
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceManifest,
  type WorkspaceManifestService,
  type WorkspaceManifestV1,
} from './types';

type JsonObject = Record<string, unknown>;

export class WorkspaceManifestValidationError extends Error {
  constructor(
    public readonly jsonPath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid ${WORKSPACE_MANIFEST_FILENAME} at ${jsonPath}: ${detail}`, options);
    this.name = 'WorkspaceManifestValidationError';
  }
}

function fail(jsonPath: string, detail: string, options?: ErrorOptions): never {
  throw new WorkspaceManifestValidationError(jsonPath, detail, options);
}

function valueKind(value: unknown): string {
  if (value === undefined) return 'a missing value';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`;
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function expectObject(value: unknown, jsonPath: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(jsonPath, `expected an object, received ${valueKind(value)}.`);
  }
  return value as JsonObject;
}

function assertAllowedKeys(value: JsonObject, allowed: readonly string[], jsonPath: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    fail(propertyPath(jsonPath, unknown), 'unknown key.');
  }
}

function expectString(value: unknown, jsonPath: string): asserts value is string {
  if (typeof value !== 'string') {
    fail(jsonPath, `expected a string, received ${valueKind(value)}.`);
  }
}

function expectStringArray(value: unknown, jsonPath: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    fail(jsonPath, `expected an array, received ${valueKind(value)}.`);
  }
  if (value.length > 32) fail(jsonPath, 'expected at most 32 entries.');
  value.forEach((entry, index) => expectString(entry, `${jsonPath}[${index}]`));
}

function validateEnvironment(value: unknown, jsonPath: string): void {
  const environment = expectObject(value, jsonPath);
  for (const [key, entry] of Object.entries(environment)) {
    expectString(entry, propertyPath(jsonPath, key));
  }
}

function validatePort(value: unknown, jsonPath: string): void {
  const port = expectObject(value, jsonPath);
  assertAllowedKeys(port, ['preferred', 'env'], jsonPath);
  const preferredPath = propertyPath(jsonPath, 'preferred');
  if (!Number.isInteger(port.preferred) || (port.preferred as number) < 1 || (port.preferred as number) > 65_535) {
    fail(preferredPath, `expected an integer from 1 through 65535, received ${valueKind(port.preferred)}.`);
  }
  if (O8_RESERVED_PORTS.has(port.preferred as number)) {
    fail(preferredPath, `port ${port.preferred} is reserved by o8.`);
  }
  if (port.env !== undefined) expectString(port.env, propertyPath(jsonPath, 'env'));
}

function validateHealth(value: unknown, jsonPath: string): void {
  const health = expectObject(value, jsonPath);
  assertAllowedKeys(health, ['http', 'tcp', 'timeoutMs'], jsonPath);
  if (health.http !== undefined) expectString(health.http, propertyPath(jsonPath, 'http'));
  if (health.tcp !== undefined && health.tcp !== true) {
    fail(propertyPath(jsonPath, 'tcp'), `expected true, received ${valueKind(health.tcp)}.`);
  }
  if (health.timeoutMs !== undefined
    && (!Number.isSafeInteger(health.timeoutMs) || Number(health.timeoutMs) < 1 || Number(health.timeoutMs) > 300_000)) {
    fail(
      propertyPath(jsonPath, 'timeoutMs'),
      `expected an integer from 1 through 300000.`,
    );
  }
}

function boundedNumber(value: unknown, jsonPath: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(jsonPath, `expected an integer from ${min} through ${max}.`);
}

function validateService(value: unknown, jsonPath: string): WorkspaceManifestService {
  const service = expectObject(value, jsonPath);
  assertAllowedKeys(service, ['name', 'command', 'cwd', 'env', 'port', 'health', 'dependsOn', 'restart', 'timeoutMs', 'outputLimitBytes', 'shutdownGraceMs'], jsonPath);
  expectString(service.name, propertyPath(jsonPath, 'name'));
  expectString(service.command, propertyPath(jsonPath, 'command'));
  if (service.cwd !== undefined) expectString(service.cwd, propertyPath(jsonPath, 'cwd'));
  if (service.env !== undefined) validateEnvironment(service.env, propertyPath(jsonPath, 'env'));
  if (service.port !== undefined) validatePort(service.port, propertyPath(jsonPath, 'port'));
  if (service.health !== undefined) validateHealth(service.health, propertyPath(jsonPath, 'health'));
  if (service.dependsOn !== undefined) expectStringArray(service.dependsOn, propertyPath(jsonPath, 'dependsOn'));
  if (service.timeoutMs !== undefined) boundedNumber(service.timeoutMs, propertyPath(jsonPath, 'timeoutMs'), 1, 86_400_000);
  if (service.outputLimitBytes !== undefined) boundedNumber(service.outputLimitBytes, propertyPath(jsonPath, 'outputLimitBytes'), 1024, 8 * 1024 * 1024);
  if (service.shutdownGraceMs !== undefined) boundedNumber(service.shutdownGraceMs, propertyPath(jsonPath, 'shutdownGraceMs'), 0, 30_000);
  if (service.restart !== undefined) {
    const restart = expectObject(service.restart, propertyPath(jsonPath, 'restart'));
    assertAllowedKeys(restart, ['maxRestarts', 'delayMs'], propertyPath(jsonPath, 'restart'));
    boundedNumber(restart.maxRestarts, propertyPath(jsonPath, 'restart.maxRestarts'), 0, 5);
    if (restart.delayMs !== undefined) boundedNumber(restart.delayMs, propertyPath(jsonPath, 'restart.delayMs'), 0, 60_000);
  }
  return service as unknown as WorkspaceManifestService;
}

function validateServices(value: unknown, jsonPath: string): void {
  if (!Array.isArray(value) || value.length > 16) {
    fail(jsonPath, 'expected an array of at most 16 services.');
  }
  const names = new Set<string>();
  value.forEach((entry, index) => {
    const servicePath = `${jsonPath}[${index}]`;
    const service = validateService(entry, servicePath);
    if (names.has(service.name)) {
      fail(propertyPath(servicePath, 'name'), `duplicate service name ${JSON.stringify(service.name)}.`);
    }
    names.add(service.name);
  });
}

function validatePreview(value: unknown, jsonPath: string): void {
  const preview = expectObject(value, jsonPath);
  assertAllowedKeys(preview, ['url', 'autoOpen'], jsonPath);
  if (preview.autoOpen !== undefined && typeof preview.autoOpen !== 'boolean') fail(propertyPath(jsonPath, 'autoOpen'), 'expected a boolean.');
  expectString(preview.url, propertyPath(jsonPath, 'url'));
}

function validateManifestV1(value: JsonObject): WorkspaceManifestV1 {
  assertAllowedKeys(value, ['version', 'setup', 'teardown', 'services', 'preview', 'limits'], '$');
  if (value.setup !== undefined) expectStringArray(value.setup, '$.setup');
  if (value.teardown !== undefined) expectStringArray(value.teardown, '$.teardown');
  if (value.services !== undefined) validateServices(value.services, '$.services');
  if (value.preview !== undefined) validatePreview(value.preview, '$.preview');
  if (value.limits !== undefined) {
    const limits = expectObject(value.limits, '$.limits');
    assertAllowedKeys(limits, ['timeoutMs', 'outputLimitBytes', 'shutdownGraceMs'], '$.limits');
    if (limits.timeoutMs !== undefined) boundedNumber(limits.timeoutMs, '$.limits.timeoutMs', 1, 45 * 60_000);
    if (limits.outputLimitBytes !== undefined) boundedNumber(limits.outputLimitBytes, '$.limits.outputLimitBytes', 1024, 8 * 1024 * 1024);
    if (limits.shutdownGraceMs !== undefined) boundedNumber(limits.shutdownGraceMs, '$.limits.shutdownGraceMs', 0, 30_000);
  }
  return value as unknown as WorkspaceManifestV1;
}

export function migrateManifest(value: unknown): WorkspaceManifest {
  const manifest = expectObject(value, '$');
  switch (manifest.version) {
    case WORKSPACE_MANIFEST_VERSION:
      return validateManifestV1(manifest);
    default:
      fail(
        '$.version',
        `unsupported workspace manifest version ${JSON.stringify(manifest.version)}; expected ${WORKSPACE_MANIFEST_VERSION}.`,
      );
  }
}

export function parseWorkspaceManifest(value: unknown): WorkspaceManifest {
  return migrateManifest(value);
}
