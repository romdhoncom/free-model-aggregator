// The brief: the provider directory, the quality table and the workload manifest, read out of
// $MAKEFUN_PROMPT_FILE. The brief is one text file that carries three JSON documents, each on a line of
// its own; this module finds them by their schema and hands them back parsed.

import { readFileSync } from 'node:fs';

export type Wire = 'openai' | 'anthropic' | 'gemini';
export type Json = { [key: string]: unknown };

export const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
export const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
export const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';

export interface DirectoryProvider {
  id: string;
  name: string;
  wire: Wire;
  auth: string;
  key_env: string;
  key: string;
  path: string;
}

export interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

export interface WorkloadRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: Requirement;
}

export interface Brief {
  directory: { providers: DirectoryProvider[] };
  ratings: { ratings: RatingRow[]; best: { id: string; rating_milli: number }[] };
  workload: { manifest: WorkloadRow[] };
  error: string | null;
}

export function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function wireOf(value: unknown): Wire {
  return value === 'anthropic' || value === 'gemini' ? value : 'openai';
}

/** Every line of the brief that parses as one JSON object, in the order they appear. */
function documents(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(value) && typeof value.schema === 'string') out.push(value);
  }
  return out;
}

function emptyBrief(error: string): Brief {
  return {
    directory: { providers: [] },
    ratings: { ratings: [], best: [] },
    workload: { manifest: [] },
    error,
  };
}

export function briefIsEmpty(brief: Brief): boolean {
  return brief.directory.providers.length === 0;
}

/** Read and parse the brief at `file`. A missing or partial brief answers an empty one, never throwing. */
export function readBrief(file: string): Brief {
  if (file === '') return emptyBrief('MAKEFUN_PROMPT_FILE is not set');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return emptyBrief(`the brief cannot be read: ${(err as Error).message}`);
  }
  const docs = documents(text);
  const providers: DirectoryProvider[] = [];
  const ratings: RatingRow[] = [];
  const best: { id: string; rating_milli: number }[] = [];
  const manifest: WorkloadRow[] = [];
  let found = 0;
  for (const doc of docs) {
    if (doc.schema === PROVIDERS_SCHEMA) {
      found += 1;
      for (const raw of Array.isArray(doc.providers) ? doc.providers : []) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        const path = str(raw.path);
        if (id === '' || path === '') continue;
        providers.push({
          id,
          name: str(raw.name) === '' ? id : str(raw.name),
          wire: wireOf(raw.wire),
          auth: str(raw.auth),
          key_env: str(raw.key_env),
          key: str(raw.key),
          path,
        });
      }
    } else if (doc.schema === RATINGS_SCHEMA) {
      found += 1;
      for (const raw of Array.isArray(doc.ratings) ? doc.ratings : []) {
        if (!isRecord(raw)) continue;
        const model = str(raw.model);
        const provider = str(raw.provider);
        if (model === '' || provider === '') continue;
        ratings.push({
          model,
          provider,
          rating_milli: num(raw.rating_milli),
          context_length: typeof raw.context_length === 'number' ? raw.context_length : null,
          tools: bool(raw.tools),
          vision: bool(raw.vision),
          json: bool(raw.json),
          free: raw.free !== false,
        });
      }
      for (const raw of Array.isArray(doc.best) ? doc.best : []) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (id === '') continue;
        best.push({ id, rating_milli: num(raw.rating_milli) });
      }
    } else if (doc.schema === WORKLOAD_SCHEMA) {
      found += 1;
      for (const raw of Array.isArray(doc.manifest) ? doc.manifest : []) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (id === '') continue;
        const requires: Requirement = {};
        const rawRequires = isRecord(raw.requires) ? raw.requires : {};
        if (rawRequires.tools === true) requires.tools = true;
        if (rawRequires.vision === true) requires.vision = true;
        if (rawRequires.json === true) requires.json = true;
        if (typeof rawRequires.min_context === 'number' && rawRequires.min_context > 0) {
          requires.min_context = rawRequires.min_context;
        }
        manifest.push({
          id,
          api: raw.api === 'anthropic' ? 'anthropic' : 'openai',
          stream: raw.stream === true,
          weight: num(raw.weight) === 2 ? 2 : 1,
          requires,
        });
      }
    }
  }
  const brief: Brief = { directory: { providers }, ratings: { ratings, best }, workload: { manifest }, error: null };
  if (found === 0) return emptyBrief('the brief carries none of the three documents');
  if (providers.length === 0) return emptyBrief('the brief carries no provider directory');
  return brief;
}
