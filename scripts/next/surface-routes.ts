/** Per-surface fixture routes. Discovery adds no application routes or auth bypasses. */
import { readdirSync } from 'node:fs';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { NextRequest } from 'next/server';

export type Route = (request: NextRequest) => Promise<Response>;
export interface SurfaceContext {
  root: string;
  dataDir: string;
  repo: string;
  fixtureToken: string;
  seeds: Array<{ id: string; title: string; messages: Array<Record<string, unknown>> }>;
  transcriptFixtures: boolean;
}
export interface RouteInput {
  route: Route;
  url: URL;
  method: string;
  body: string;
  headers: IncomingHttpHeaders;
}
export interface SurfaceRoutes {
  priority?: number;
  early?: boolean;
  routes?: Record<string, Route>;
  match?: (method: string, pathname: string) => Route | undefined;
  admit?: (input: RouteInput) => number;
  before?: (input: RouteInput) => void;
  run?: (route: Route, request: NextRequest) => Promise<Response>;
  after?: (input: RouteInput, response: Response) => Promise<boolean> | boolean;
  stream?: Route[];
  receipt?: Record<string, unknown>;
  close?: () => Promise<void> | void;
  socket?: (server: Server, token: string, requests: string[]) => Promise<() => void>;
}
interface Entry {
  prepare?: (context: SurfaceContext) => Promise<SurfaceRoutes>;
  default?: (context: SurfaceContext) => Promise<SurfaceRoutes>;
}
export async function surfaceEntries() {
  const directory = new URL('./surfaces/', import.meta.url);
  const entries: Entry[] = [];
  // Sorted names preserve fixture initialization and overlapping-route precedence.
  for (const file of readdirSync(fileURLToPath(directory)).filter(file => file.endsWith('.surface.ts')).sort()) {
    entries.push(await import(new URL(file, directory).href) as Entry);
  }
  return entries;
}
