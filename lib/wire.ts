// The wires: one request rewritten into each provider wire, and each provider's answer written back
// into the wire the client used. Nothing here reads the clock: every id and timestamp is a constant, so
// two passes of the same trial answer byte for byte the same.

import type { Json, Wire } from './brief.ts';
import { isRecord } from './brief.ts';

/** A timestamp fixed for every answer: a replay must not differ because the wall clock did. */
export const FIXED_CREATED = 1767225600;
/** How much text one streamed delta carries. */
const CHUNK_CHARS = 64;

export interface Usage {
  input: number;
  output: number;
}

export interface ProviderAnswer {
  ok: boolean;
  status: number;
  text: string;
  usage: Usage;
  stop: string;
  code: string;
}

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The auth headers a provider's own wire carries its key in. */
export function authHeaders(auth: string, key: string): Record<string, string> {
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

/** The provider's catalog route for its wire. */
export function catalogPath(wire: Wire): string {
  return wire === 'gemini' ? '/v1beta/models' : '/v1/models';
}

/** The provider's inference route for its wire, and the body to send it. */
export function inferencePath(wire: Wire, model: string): string {
  if (wire === 'anthropic') return '/v1/messages';
  if (wire === 'gemini') return `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return '/v1/chat/completions';
}

/** One model row a provider's catalog route lists. */
export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

/** Read one provider's catalog answer, in whichever of the three wires it came. */
export function readCatalog(wire: Wire, body: unknown): CatalogModel[] {
  const out: CatalogModel[] = [];
  if (!isRecord(body)) return out;
  const rows: unknown[] = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    let id: string | null = typeof raw.id === 'string' ? raw.id : null;
    if (id === null && typeof raw.name === 'string') {
      const name = raw.name;
      id = name.startsWith('models/') ? name.slice('models/'.length) : name;
    }
    if (id === null || id === '') continue;
    const context = raw.context_length ?? raw.inputTokenLimit;
    out.push({
      id,
      free: raw.free !== false,
      context_length: typeof context === 'number' && Number.isFinite(context) ? context : null,
    });
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function dataUrlOf(source: Json): string | null {
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return `data:${media};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  return null;
}

function imageBlockOf(url: string): Json | null {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(url);
  if (match !== null) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  return null;
}

/** An Anthropic-shaped client request, rewritten for an OpenAI-wire provider. */
function toOpenAI(body: Json): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) continue;
    const role = raw.role === 'assistant' ? 'assistant' : 'user';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blocks: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isRecord(block.source)) {
        const url = dataUrlOf(block.source);
        if (url !== null) blocks.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'image_url' && isRecord(block.image_url) && typeof block.image_url.url === 'string') {
        blocks.push({ type: 'image_url', image_url: { url: block.image_url.url } });
      }
    }
    messages.push({ role, content: blocks.length > 0 ? blocks : '' });
  }
  const out: Json = { messages };
  if (Array.isArray(body.tools)) {
    const tools: Json[] = [];
    for (const raw of body.tools) {
      if (!isRecord(raw)) continue;
      const fn = isRecord(raw.function) ? raw.function : raw;
      const name = typeof fn.name === 'string' ? fn.name : null;
      if (name === null) continue;
      tools.push({
        type: 'function',
        function: {
          name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: isRecord(fn.parameters) ? fn.parameters : isRecord(fn.input_schema) ? fn.input_schema : { type: 'object', properties: {} },
        },
      });
    }
    if (tools.length > 0) {
      out.tools = tools;
      const choice = body.tool_choice;
      if (isRecord(choice) && typeof choice.type === 'string') {
        if (choice.type === 'auto') out.tool_choice = 'auto';
        else if (choice.type === 'any' || choice.type === 'required') out.tool_choice = 'required';
        else if (choice.type === 'none') out.tool_choice = 'none';
        else if ((choice.type === 'tool' || choice.type === 'function') && typeof choice.name === 'string') {
          out.tool_choice = { type: 'function', function: { name: choice.name } };
        }
      }
    }
  }
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  else if (typeof body.stop_sequences === 'string' && body.stop_sequences !== '') out.stop = body.stop_sequences;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (isRecord(body.response_format)) out.response_format = body.response_format;
  return out;
}

/** An OpenAI-shaped client request, rewritten for an Anthropic-wire provider. */
function toAnthropic(body: Json): Json {
  const messages: Json[] = [];
  const systemParts: string[] = [];
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) continue;
    const role = raw.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    const mapped: Json = role === 'assistant' ? 'assistant' : 'user';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: mapped, content: [{ type: 'text', text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blocks: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'image_url' && isRecord(block.image_url) && typeof block.image_url.url === 'string') {
        const image = imageBlockOf(block.image_url.url);
        if (image !== null) blocks.push(image);
      }
    }
    messages.push({ role: mapped, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
  }
  const out: Json = { messages };
  if (systemParts.length > 0) out.system = systemParts.join('\n');
  if (Array.isArray(body.tools)) {
    const tools: Json[] = [];
    for (const raw of body.tools) {
      if (!isRecord(raw)) continue;
      const fn = isRecord(raw.function) ? raw.function : raw;
      const name = typeof fn.name === 'string' ? fn.name : null;
      if (name === null) continue;
      tools.push({
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        input_schema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
      });
    }
    if (tools.length > 0) {
      out.tools = tools;
      const choice = body.tool_choice;
      if (choice === 'auto') out.tool_choice = { type: 'auto' };
      else if (choice === 'required') out.tool_choice = { type: 'any' };
      else if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === 'string') {
        out.tool_choice = { type: 'tool', name: choice.function.name };
      }
    }
  }
  const max = typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : null;
  if (max !== null) out.max_tokens = max;
  const stop = body.stop;
  if (Array.isArray(stop) && stop.length > 0) out.stop_sequences = stop.filter((s) => typeof s === 'string');
  else if (typeof stop === 'string' && stop !== '') out.stop_sequences = [stop];
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  return out;
}

/** Either client request, rewritten for a Gemini-wire provider. */
function toGemini(body: Json, api: 'openai' | 'anthropic'): Json {
  const openai = api === 'openai' ? body : toOpenAI(body);
  const contents: Json[] = [];
  const systemText = systemOf(openai, api, body);

  for (const raw of Array.isArray(openai.messages) ? openai.messages : []) {
    if (!isRecord(raw) || raw.role === 'system') continue;
    const role = raw.role === 'assistant' ? 'model' : 'user';
    const blockParts: Json[] = [];
    const content = raw.content;
    if (typeof content === 'string') {
      if (content !== '') blockParts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') blockParts.push({ text: block.text });
        else if (block.type === 'image_url' && isRecord(block.image_url) && typeof block.image_url.url === 'string') {
          const match = /^data:([^;,]*);base64,(.*)$/s.exec(block.image_url.url);
          if (match !== null) blockParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          else blockParts.push({ fileData: { mimeType: 'image/png', fileUri: block.image_url.url } });
        }
      }
    }
    contents.push({ role, parts: blockParts });
  }
  const out: Json = { contents };
  if (systemText !== '') out.systemInstruction = { parts: [{ text: systemText }] };
  if (Array.isArray(openai.tools)) {
    const declarations: Json[] = [];
    for (const raw of openai.tools) {
      if (!isRecord(raw) || !isRecord(raw.function)) continue;
      const fn = raw.function;
      if (typeof fn.name !== 'string') continue;
      declarations.push({ name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters: fn.parameters ?? { type: 'object', properties: {} } });
    }
    if (declarations.length > 0) out.tools = [{ functionDeclarations: declarations }];
  }
  const config: Json = {};
  if (typeof openai.max_tokens === 'number') config.maxOutputTokens = openai.max_tokens;
  const stop = openai.stop;
  if (Array.isArray(stop) && stop.length > 0) config.stopSequences = stop.filter((s) => typeof s === 'string');
  else if (typeof stop === 'string' && stop !== '') config.stopSequences = [stop];
  if (typeof openai.temperature === 'number') config.temperature = openai.temperature;
  const format = isRecord(openai.response_format) ? openai.response_format.type : null;
  if (format === 'json_object' || format === 'json_schema') config.responseMimeType = 'application/json';
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

function systemFromOpenAI(body: Json): string {
  const parts: string[] = [];
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) continue;
    if (raw.role !== 'system' && raw.role !== 'developer') continue;
    const text = textOf(raw.content);
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

/** The system prompt of either client wire, as one string. */
function systemOf(openaiBody: Json, api: 'openai' | 'anthropic', original: Json): string {
  if (api === 'anthropic') return textOf(original.system);
  return systemFromOpenAI(openaiBody);
}

/**
 * The body to send a provider: the client's request rewritten into the provider's wire, naming the
 * model it is routed to and asking for one plain answer (the client's stream is written here, not there).
 */
export function upstreamBody(api: 'openai' | 'anthropic', body: Json, wire: Wire, model: string): Json {
  let out: Json;
  if (wire === 'openai') out = api === 'openai' ? { ...body } : toOpenAI(body);
  else if (wire === 'anthropic') out = api === 'anthropic' ? { ...body } : toAnthropic(body);
  else out = toGemini(body, api);
  out = { ...out, model };
  delete out.stream;
  delete out.stream_options;
  return out;
}

/** Read a provider's answer, whichever wire it answered in. */
export function providerAnswer(wire: Wire, status: number, raw: string): ProviderAnswer {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (status < 200 || status >= 300) {
    let code = 'upstream_error';
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.code === 'string') code = body.error.code;
      else if (typeof body.error.type === 'string') code = body.error.type;
    }
    return { ok: false, status, text: '', usage: { input: 0, output: 0 }, stop: '', code };
  }
  if (!isRecord(body)) return { ok: false, status: 502, text: '', usage: { input: 0, output: 0 }, stop: '', code: 'unreadable_answer' };
  if (wire === 'openai') {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      ok: true,
      status,
      text: textOf(message.content),
      usage: {
        input: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        output: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      },
      stop: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
      code: '',
    };
  }
  if (wire === 'anthropic') {
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      ok: true,
      status,
      text: textOf(body.content),
      usage: {
        input: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        output: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      },
      stop: typeof body.stop_reason === 'string' ? body.stop_reason : 'end_turn',
      code: '',
    };
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const partsText = Array.isArray(content.parts)
    ? content.parts.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
    : '';
  const metadata = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return {
    ok: true,
    status,
    text: partsText,
    usage: {
      input: typeof metadata.promptTokenCount === 'number' ? metadata.promptTokenCount : 0,
      output: typeof metadata.candidatesTokenCount === 'number' ? metadata.candidatesTokenCount : 0,
    },
    stop: typeof candidate.finishReason === 'string' ? candidate.finishReason : 'STOP',
    code: '',
  };
}

/** The stop reason a client's wire speaks for a provider's own. */
function clientStop(api: 'openai' | 'anthropic', stop: string): string {
  const family = stop === 'length' || stop === 'max_tokens' || stop === 'MAX_TOKENS' ? 1 : stop === 'tool_calls' || stop === 'function_call' || stop === 'tool_use' ? 2 : stop === 'content_filter' || stop === 'refusal' || stop === 'SAFETY' ? 3 : 0;
  if (api === 'openai') return family === 1 ? 'length' : family === 2 ? 'tool_calls' : family === 3 ? 'content_filter' : 'stop';
  return family === 1 ? 'max_tokens' : family === 2 ? 'tool_use' : family === 3 ? 'refusal' : 'end_turn';
}

function chunks(text: string): string[] {
  if (text === '') return [''];
  const out: string[] = [];
  for (let at = 0; at < text.length; at += CHUNK_CHARS) out.push(text.slice(at, at + CHUNK_CHARS));
  return out;
}

function sse(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** The client's OpenAI-wire answer, JSON or streamed. */
export function openAIReply(text: string, usage: Usage, model: string, stream: boolean, stop: string): Reply {
  const finish = clientStop('openai', stop);
  if (!stream) {
    const body = {
      id: 'chatcmpl-entry',
      object: 'chat.completion',
      created: FIXED_CREATED,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish, logprobs: null }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }
  const chunk = (delta: Json, reason: string | null): Json => ({
    id: 'chatcmpl-entry',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: reason }],
  });
  const frames = [sse(null, chunk({ role: 'assistant', content: '' }, null))];
  for (const piece of chunks(text)) frames.push(sse(null, chunk({ content: piece }, null)));
  frames.push(sse(null, chunk({}, finish)));
  frames.push('data: [DONE]\n\n');
  return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }, body: frames.join('') };
}

/** The client's Anthropic-wire answer, JSON or streamed. */
export function anthropicReply(text: string, usage: Usage, model: string, stream: boolean, stop: string): Reply {
  const reason = clientStop('anthropic', stop);
  if (!stream) {
    const body = {
      id: 'msg_entry',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: reason,
      stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: usage.output },
    };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }
  const frames = [
    sse('message_start', {
      type: 'message_start',
      message: { id: 'msg_entry', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 0 } },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (const piece of chunks(text)) frames.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
  frames.push(
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: usage.output } }),
    sse('message_stop', { type: 'message_stop' }),
  );
  return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }, body: frames.join('') };
}

/** An error in the client's own wire. */
export function errorReply(api: 'openai' | 'anthropic', status: number, code: string, message: string): Reply {
  const body =
    api === 'openai'
      ? { error: { message, type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', param: null, code } }
      : { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message } };
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The model list, in the shape of the auth header the client sent. */
export function modelList(api: 'openai' | 'anthropic', models: { id: string; created: number }[]): Reply {
  const body =
    api === 'anthropic'
      ? { data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: models[0]?.id ?? null, last_id: models[models.length - 1]?.id ?? null }
      : { object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', created: m.created, owned_by: 'aggregator' })) };
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
