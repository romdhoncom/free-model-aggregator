// The best free AI model aggregator: one server, two client wires, ten free-tier providers.
//
// A trial gives this server the brief at $MAKEFUN_PROMPT_FILE and the env at $MAKEFUN_ENV_URL. It probes
// every provider's catalog route in the provider's own wire, registers the one catalog the probes saw,
// serves the client's OpenAI and Anthropic requests with the best free model that meets each request and
// still has budget, fails over to the next best when a provider refuses, and exits 0 when the env says the
// workload is done. It reads no clock and draws no randomness, so a replay answers as the live pass did.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readBrief, type Json, type Requirement, isRecord } from './lib/brief.ts';
import { buildCatalog, candidatesFor, freeModelIds, joinBase, probeProvider, type CatalogDocument, type Candidate, type Probe } from './lib/catalog.ts';
import { authHeaders, anthropicReply, errorReply, inferencePath, modelList, openAIReply, providerAnswer, upstreamBody, FIXED_CREATED, type ProviderAnswer, type Reply } from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 5000;
const PROVIDER_TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** How many providers one request may try before it gives up. */
const MAX_ATTEMPTS = 8;
/** A provider refused this many calls running: spend no more calls on it this trial. */
const RETIRE_AFTER = 3;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogDocument = { providers: [] };
let manifestIndex = 0;
let trialNow = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** Which providers still answer: a provider that refuses three calls running is taken to be out of budget. */
class Health {
  refusals = new Map<string, number>();
  retired = new Set<string>();

  alive(id: string): boolean {
    return !this.retired.has(id);
  }

  served(id: string): void {
    this.refusals.set(id, 0);
  }

  refused(id: string, code: string): void {
    if (code === 'concurrent_requests') return;
    const count = (this.refusals.get(id) ?? 0) + 1;
    this.refusals.set(id, count);
    if (count >= RETIRE_AFTER) this.retired.add(id);
  }
}

const health = new Health();

/** Probe every provider and build the one catalog. */
async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.directory.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS)));
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(probes);
  log(`catalog: ${catalog.providers.length} providers, ${freeModelIds(catalog).length} free models, ${catalog.providers.reduce((n, p) => n + p.models.filter((m) => !m.free).length, 0)} paid`);
}

/** A request's requirements: the manifest row of the request now arriving, else what its body shows. */
function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload.manifest;
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

function requirementsFromBody(body: Json): Requirement {
  const requires: Requirement = {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) requires.vision = true;
    }
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) requires.tools = true;
  const format = isRecord(body.response_format) ? body.response_format.type : null;
  if (format === 'json_object' || format === 'json_schema') requires.json = true;
  return requires;
}

/** Whether a request asks for JSON mode on the OpenAI wire: only an OpenAI-wire provider can echo that. */
function wantsJson(body: Json, api: 'openai' | 'anthropic'): boolean {
  if (api === 'anthropic') return false;
  const format = isRecord(body.response_format) ? body.response_format.type : null;
  return format === 'json_object' || format === 'json_schema';
}

/** One provider call: the provider's answer, its status, or a delivery error. */
async function callProvider(candidate: Candidate, api: 'openai' | 'anthropic', body: Json): Promise<ProviderAnswer> {
  const url = `${joinBase(ENV_URL, candidate.provider.path)}${inferencePath(candidate.provider.wire, candidate.model)}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(candidate.provider.auth, candidate.provider.key) };
  if (candidate.provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const upstream = upstreamBody(api, body, candidate.provider.wire, candidate.model);
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upstream), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    return providerAnswer(candidate.provider.wire, response.status, await response.text());
  } catch (err) {
    return { ok: false, status: 502, text: '', usage: { input: 0, output: 0 }, stop: '', code: `unreachable: ${(err as Error).message}` };
  }
}

/** Answer one client request: the best free model that meets it, failing over down the ranking. */
async function serve(api: 'openai' | 'anthropic', body: Json): Promise<Reply> {
  const stream = body.stream === true;
  const requires = requirementsFor(body);
  const json = wantsJson(body, api);
  const candidates = candidatesFor(brief, probes, requires).filter((candidate) => !json || candidate.provider.wire === 'openai');
  if (candidates.length === 0) return errorReply(api, 503, 'no_free_model', 'no free model on the directory meets this request');
  let attempts = 0;
  let last: ProviderAnswer | null = null;
  for (const candidate of candidates) {
    if (!health.alive(candidate.provider.id)) continue;
    if (attempts >= MAX_ATTEMPTS) break;
    // A refusal is often one entry of a provider's failure schedule and the next call answers, so ask
    // the same model again once before falling down the ranking.
    for (let try_ = 0; try_ < 2; try_ += 1) {
      if (attempts >= MAX_ATTEMPTS) break;
      attempts += 1;
      const answer = await callProvider(candidate, api, body);
      if (answer.ok && answer.text !== '') {
        health.served(candidate.provider.id);
        log(`${api}${stream ? '-stream' : ''} served by ${candidate.provider.id}/${candidate.model} (${candidate.rating}) on call ${attempts}`);
        return api === 'openai' ? openAIReply(answer.text, answer.usage, candidate.model, stream, answer.stop) : anthropicReply(answer.text, answer.usage, candidate.model, stream, answer.stop);
      }
      last = answer;
      health.refused(candidate.provider.id, answer.code);
      log(`${candidate.provider.id}/${candidate.model} refused (${answer.status} ${answer.code})`);
      if (answer.status === 400 || answer.status === 401 || answer.status === 404) break;
    }
  }
  return errorReply(api, 502, last?.code ?? 'no_free_model', last === null ? 'no provider answered' : `every free model refused this request (last: HTTP ${last.status} ${last.code})`);
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, { ...reply.headers, 'content-length': Buffer.byteLength(reply.body) });
  res.end(reply.body);
}

/** GET /v1/models: the OpenAI list for a Bearer request, the Anthropic one for x-api-key. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = freeModelIds(catalog).map((id) => ({ id, created: FIXED_CREATED }));
  const api = typeof req.headers['x-api-key'] === 'string' ? 'anthropic' : 'openai';
  send(res, modelList(api, list));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const api = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
    const body = await readJson(req);
    if (body === null) {
      send(res, errorReply(api, 400, 'invalid_request_error', 'the request body is not one JSON object'));
      return;
    }
    send(res, await serve(api, body));
    return;
  }
  send(res, errorReply(url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server has no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function register(port: number, report: CatalogDocument): Promise<void> {
  const response = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  try {
    const reply: unknown = JSON.parse(text);
    if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
  } catch {
    log('registered');
  }
}

/** GET /instance carries the instance's own opening time; nothing else here reads a clock. */
async function readInstance(): Promise<void> {
  try {
    const response = await fetch(`${ENV_URL}/instance`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.now === 'number') trialNow = body.now;
  } catch {
    // The env need not answer it: nothing depends on the value.
  }
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const response = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (response.status !== 200) return;
        const work: unknown = await response.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not up yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  await readInstance();
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) send(res, errorReply(req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer'));
    });
  });
  const port = await listen(server);
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} (trial now ${String(trialNow)})`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
