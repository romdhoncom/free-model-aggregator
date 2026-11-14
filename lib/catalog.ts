// The catalog: ask every provider what it serves, in its own wire, and write down one document. The
// document is what `--list` prints and what the register body carries, byte for byte.

import type { Brief, DirectoryProvider, Json, RatingRow, Requirement } from './brief.ts';
import { authHeaders, catalogPath, readCatalog, type CatalogModel } from './wire.ts';

/** One provider's catalog route, as it answered. */
export interface Probe {
  provider: DirectoryProvider;
  ok: boolean;
  models: CatalogModel[];
  error: string | null;
}

export interface CatalogDocument {
  providers: {
    id: string;
    base_url: string;
    key_env: string;
    wire: string;
    models: { id: string; free: boolean; context_length: number | null }[];
  }[];
}

/** Where a provider is dialled: the env's origin joined to the provider's own path. */
export function joinBase(envUrl: string, path: string): string {
  return `${envUrl.replace(/\/+$/, '')}${path}`;
}

/** GET one provider's catalog route with its own auth. Never throws: an unreachable provider is !ok. */
export async function probeProvider(envUrl: string, provider: DirectoryProvider, timeoutMs: number): Promise<Probe> {
  const url = `${joinBase(envUrl, provider.path)}${catalogPath(provider.wire)}`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (!response.ok) return { provider, ok: false, models: [], error: `${provider.id} answered HTTP ${response.status}: ${text.slice(0, 200)}` };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { provider, ok: false, models: [], error: `${provider.id} answered a body that is not JSON` };
    }
    const models = readCatalog(provider.wire, body);
    if (models.length === 0) return { provider, ok: false, models, error: `${provider.id} listed no model` };
    return { provider, ok: true, models, error: null };
  } catch (err) {
    return { provider, ok: false, models: [], error: `${provider.id} could not be reached: ${(err as Error).message}` };
  }
}

/** The one catalog document: every provider that answered, with the free and the paid models it listed. */
export function buildCatalog(probes: Probe[]): CatalogDocument {
  const providers: CatalogDocument['providers'] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    providers.push({
      id: probe.provider.id,
      base_url: probe.provider.path,
      key_env: probe.provider.key_env,
      wire: probe.provider.wire,
      models: probe.models.map((model) => ({ id: model.id, free: model.free, context_length: model.context_length })),
    });
  }
  return { providers };
}

/** The free model ids the catalog registers: what GET /v1/models answers with either auth header. */
export function freeModelIds(catalog: CatalogDocument): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (model.free !== true) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      ids.push(model.id);
    }
  }
  return ids;
}

export interface Candidate {
  provider: DirectoryProvider;
  model: string;
  rating: number;
}

/** Whether a model the quality table rates meets a request's requirements. */
export function meets(row: RatingRow | null, requires: Requirement): boolean {
  if (row === null) return Object.keys(requires).length === 0;
  if (requires.tools === true && !row.tools) return false;
  if (requires.vision === true && !row.vision) return false;
  if (requires.json === true && !row.json) return false;
  if (requires.min_context !== undefined) {
    if (row.context_length === null || row.context_length < requires.min_context) return false;
  }
  return true;
}

/** Every free model that meets a request's requirements, best rating first. */
export function candidatesFor(brief: Brief, probes: Probe[], requires: Requirement): Candidate[] {
  const byKey = new Map<string, RatingRow>();
  for (const row of brief.ratings.ratings) byKey.set(`${row.provider}/${row.model}`, row);
  const out: Candidate[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of probe.models) {
      if (model.free !== true) continue;
      const row = byKey.get(`${probe.provider.id}/${model.id}`) ?? null;
      if (row !== null && row.free !== true) continue;
      if (!meets(row, requires)) continue;
      // A JSON-mode OpenAI request can only be answered where the wire can carry response_format.
      out.push({ provider: probe.provider, model: model.id, rating: row === null ? 0 : row.rating_milli });
    }
  }
  out.sort((a, b) => (b.rating - a.rating) || (a.provider.id < b.provider.id ? -1 : a.provider.id > b.provider.id ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return out;
}

/** The catalog truth shape the scorer reads, for a local self-check (not sent anywhere). */
export function describeCatalog(catalog: CatalogDocument): Json {
  return { providers: catalog.providers.map((provider) => ({ ...provider })) };
}
