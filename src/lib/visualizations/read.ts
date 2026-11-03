import 'server-only';
import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { getVisualization, getVisualizationMetadata } from './store';
import type { VisualizationDocument } from './types';
import { VISUALIZATION_ID } from './types';
import { VisualizationError } from './errors';

// Reads retain packet ownership checks without loading publication/preview code.
function validateRead(id: string, principal: RequestPrincipalContext): void {
  if (principal.role !== 'operator' && principal.role !== 'worker') throw new VisualizationError('unauthorized', 'Visualization access requires an operator or packet worker credential.', 401);
  if (!VISUALIZATION_ID.test(id)) throw new VisualizationError('not_found', 'Visualization not found.', 404);
}

function authorizeRead<T extends { packetId: string | null }>(document: T | null, principal: RequestPrincipalContext): T {
  if (!document || (principal.role === 'worker' && (principal.readOnly || !principal.packetId || principal.packetId !== document.packetId))) {
    throw new VisualizationError('not_found', 'Visualization not found.', 404);
  }
  return document;
}

export function readVisualization(id: string, principal: RequestPrincipalContext): VisualizationDocument {
  validateRead(id, principal);
  return authorizeRead(getVisualization(id), principal);
}

export function readVisualizationMetadata(id: string, principal: RequestPrincipalContext) {
  validateRead(id, principal);
  return authorizeRead(getVisualizationMetadata(id), principal);
}
