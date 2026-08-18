// Dialeto Anthropic (Messages API): /v1/messages, /v1/messages/count_tokens,
// /v1/models, /v1/models/{id}. Mesmo upstream (POST /alpha/generate) do dialeto OpenAI.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";

import { EFFORT_LEVELS, MODELS, resolveModel, type Model } from "./models.ts";
import {
  DEFAULT_SYSTEM, UPSTREAM_IDLE_TIMEOUT_MS,
  buildGenerateBody, callUpstream, classifyUpstreamError,
  errMessage, errStatus, imageUrlToDataUri, json, makeStopFilter, readBody, readEvents,
  sseHead, StreamError, toWireTools, upstreamErrorMessage,
  type ErrorKind, type WireImage, type WireMessage, type WirePart, type WireToolCallEvent, type WireUsage,
} from "./upstream.ts";

const BOOT_ISO = new Date().toISOString();

// ---------- shapes do request Anthropic (só o que o proxy lê) ----------
interface AnthropicBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}

interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicBlock[] | null;
}

interface MessagesBody {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicBlock[];
  max_tokens?: number;
  temperature?: unknown;
  top_p?: unknown;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: unknown;
  tool_choice?: { type?: string; name?: string };
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  reasoning_effort?: string;
  reasoning?: { effort?: string };
  effort?: string;
  level?: string;
  depth?: string | number;
}

// blocos de conteúdo devolvidos ao cliente
type OutBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

// kind neutro do upstream -> error.type do Anthropic
const ERROR_MAP: Record<ErrorKind, string> = {
  rate_limit: "rate_limit_error",
  auth: "authentication_error",
  permission: "permission_error",
  not_found: "not_found_error",
  invalid: "invalid_request_error",
  overloaded: "overloaded_error",
  upstream: "api_error",
};
function mapUpstreamError(status: number, message: string) {
  const { kind, status: mapped } = classifyUpstreamError(status, message);
  return { status: mapped, type: ERROR_MAP[kind] };
}

const hex = (n: number) => randomBytes(n).toString("hex");
const messageId = () => `msg_${hex(12)}`;
const toolUseId = () => `toolu_${hex(12)}`;
const requestId = () => `req_${hex(12)}`;

// Retry-After no 429 (rate_limit): o Claude Code lê o header pra backoff. No meio de um stream
// SSE os headers já foram enviados — lá o que vale é o error.type rate_limit_error.
function setRetryAfter(res: ServerResponse, status: number): void {
  if (status === 429 && !res.headersSent) res.setHeader("Retry-After", "30");
}

// keepalive do stream (mesmo heartbeat da Messages API real) e pacing do reasoning
const PING_MS = 3000;
const THINK_CHUNK = 48; // runes por thinking_delta (mesmo budget do routatic)
const THINK_DELAY = 80; // ms entre deltas
const THINK_PACING_BUDGET = 3000; // pacing total máximo por stream

function chunkRunes(s: string, n: number): string[] {
  const runes = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < runes.length; i += n) out.push(runes.slice(i, i + n).join(""));
  return out;
}

export function anthropicError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
  json(res, status, { type: "error", error: { type, message }, request_id: requestId() });
}

function modelObject(m: Model) {
  return { id: m.id, type: "model", display_name: m.id.split("/").pop(), created_at: BOOT_ISO };
}

// ---------- request Anthropic -> wire do commandcode ----------
function systemOf(body: MessagesBody): string {
  const s = body.system;
  let text = "";
  if (typeof s === "string") text = s;
  else if (Array.isArray(s)) {
    text = s.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n\n");
  }
  // a wire não tem tool_choice; vira instrução no system (best-effort)
  const extra: string[] = [];
  const tc = body.tool_choice;
  if (tc?.type === "any") extra.push("Você DEVE chamar pelo menos uma das ferramentas disponíveis nesta resposta.");
  else if (tc?.type === "tool" && tc.name) extra.push(`Você DEVE chamar a ferramenta \`${tc.name}\` nesta resposta.`);
  return [text.trim() ? text : DEFAULT_SYSTEM, ...extra].join("\n\n");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  }
  return "";
}

async function imageBlockToWire(block: AnthropicBlock): Promise<WireImage> {
  const src = block.source ?? {};
  if (src.type === "base64") {
    const mime = src.media_type || "image/png";
    return { image: `data:${mime};base64,${src.data ?? ""}`, mimeType: mime };
  }
  if (src.type === "url") return imageUrlToDataUri(src.url ?? "");
  throw new Error("image.source precisa ser {type:'base64'} ou {type:'url'}.");
}

// mapa tool_use_id -> nome, lido dos blocos tool_use das mensagens assistant anteriores
function buildToolNameMap(messages: AnthropicMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) if (b?.type === "tool_use" && b.id) map.set(b.id, b.name ?? "unknown");
  }
  return map;
}

async function toWireMessages(messages: AnthropicMessage[]): Promise<WireMessage[]> {
  const toolName = buildToolNameMap(messages);
  const wire: WireMessage[] = [];
  for (const msg of messages) {
    if (!msg) continue;
    const raw = msg.content;
    const blocks: AnthropicBlock[] = typeof raw === "string"
      ? (raw ? [{ type: "text", text: raw }] : [])
      : Array.isArray(raw) ? raw : [];

    if (msg.role === "assistant") {
      const parts: WirePart[] = [];
      // O Claude Code também pode anexar `thinking` diretamente ao tool_use. Detectar
      // antes do loop permite pôr o placeholder no começo do turno, como exige a ordem
      // Anthropic (thinking → text/tool), em vez de inseri-lo depois de um bloco text.
      const hasToolUse = blocks.some((b) => b?.type === "tool_use");
      const hasDedicatedReasoning = blocks.some((b) =>
        b?.type === "thinking" || b?.type === "redacted_thinking");
      const inlineReasoning = blocks.find((b) =>
        b?.type === "tool_use" && typeof b.thinking === "string" && b.thinking.length > 0)?.thinking;
      if (hasToolUse && !hasDedicatedReasoning) {
        parts.push({ type: "reasoning", text: inlineReasoning ?? " " });
      }
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
        else if (b.type === "thinking" && typeof b.thinking === "string") {
          // Preserva a trilha de reasoning no round-trip (o commandcode aceita replay).
          parts.push({ type: "reasoning", text: b.thinking });
        } else if (b.type === "redacted_thinking") {
          // sem conteúdo (censurado); o placeholder marca o turno como "pensou"
          parts.push({ type: "reasoning", text: " " });
        } else if (b.type === "tool_use") {
          parts.push({
            type: "tool-call",
            toolCallId: b.id ?? toolUseId(),
            toolName: b.name ?? "unknown",
            input: b.input ?? {},
          });
        }
      }
      // assistant vazio quebra a validação Zod do upstream
      if (parts.length) wire.push({ role: "assistant", content: parts });
      continue;
    }

    // user (e qualquer role desconhecido): tool_result vira mensagem wire `tool`, o resto vira `user`
    const toolResults: WirePart[] = [];
    const rest: WirePart[] = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === "tool_result") {
        const inner = Array.isArray(b.content) ? b.content as AnthropicBlock[] : [];
        const hasImage = inner.some((part) => part?.type === "image");
        const value = toolResultText(b.content) || (hasImage ? "[Image returned by tool]" : "");
        toolResults.push({
          type: "tool-result",
          toolCallId: b.tool_use_id ?? "",
          toolName: toolName.get(b.tool_use_id ?? "") ?? "unknown",
          // a wire não tem flag de erro no tool-result
          output: { type: "text", value: b.is_error === true ? `Error: ${value}` : value },
        });
        // A wire não aceita imagem dentro de output:text. Preserve a evidência visual
        // como uma mensagem user imediatamente depois dos tool results.
        for (const part of inner) {
          if (part?.type === "image") rest.push({ type: "image", ...(await imageBlockToWire(part)) });
        }
      } else if (b.type === "text") {
        if (b.text) rest.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        rest.push({ type: "image", ...(await imageBlockToWire(b)) });
      } else if (b.type === "document") {
        throw new Error("blocos `document` (PDF) não são suportados por este proxy.");
      }
    }
    if (toolResults.length) wire.push({ role: "tool", content: toolResults });
    if (rest.length) wire.push({ role: "user", content: rest });
  }
  return wire;
}

function usageOf(u: WireUsage | null) {
  if (!u) return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const cacheRead = Math.max(u.cachedInputTokens ?? 0, u.inputTokenDetails?.cacheReadTokens ?? 0);
  const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  // Medição real confirmou que inputTokens é o prompt TOTAL. Em cache hit: inputTokens=4894,
  // noCacheTokens=30 e cacheReadTokens=4864. Anthropic espera em input_tokens somente a
  // parcela regular; publicar o total junto do cache_read conta o contexto duas vezes.
  const regularInput = u.inputTokenDetails?.noCacheTokens
    ?? Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite);
  return {
    input_tokens: regularInput,
    output_tokens: u.outputTokens ?? 0,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
}

// ---------- handler ----------
// devolve true se tratou a rota, false se ela não é do dialeto Anthropic
// A wire do commandcode não tem orçamento de tokens de raciocínio, só reasoning_effort.
// Faixas iguais às do routatic-proxy, pros dois se comportarem igual no mesmo harness.
function budgetTokensToEffort(budget: number | undefined): string | null {
  if (typeof budget !== "number" || budget <= 0) return null;
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 32768) return "high";
  return "max";
}

// ---------- count_tokens: tokenizer cl100k real + estimativa de imagem ----------
// cl100k_base explícito. O export principal de gpt-tokenizer 4 usa o200k_base, então importar
// da raiz não reproduz a heurística da referência. Para DeepSeek ainda é uma aproximação.
const textTokens = (s: string) => (s ? encode(s).length : 0);

// heurística do routatic: ~rawBytes/75, clamp 300-4000; URL sem dados → 1500 default
function imageTokens(block: AnthropicBlock): number {
  const src = block.source ?? {};
  if (src.type === "base64") {
    const rawBytes = Math.floor(((src.data ?? "").length * 3) / 4);
    return Math.max(300, Math.min(4000, Math.floor(rawBytes / 75)));
  }
  return 1500;
}

function countContentTokens(blocks: AnthropicBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) n += textTokens(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") n += textTokens(b.thinking);
    else if (b.type === "tool_use") n += textTokens(JSON.stringify(b.input ?? {}));
    else if (b.type === "tool_result") n += typeof b.content === "string" ? textTokens(b.content) : countContentTokens((b.content ?? []) as AnthropicBlock[]);
    else if (b.type === "image") n += imageTokens(b);
    else if (b.type === "redacted_thinking") n += 1;
  }
  return n;
}

function countTokensBody(body: MessagesBody): number {
  let n = 3; // framing inicial
  if (typeof body.system === "string") n += textTokens(body.system) + 5;
  else if (Array.isArray(body.system)) n += countContentTokens(body.system as AnthropicBlock[]) + 5;
  for (const msg of body.messages ?? []) {
    if (!msg) continue;
    const c = msg.content;
    if (typeof c === "string") n += textTokens(c) + 5;
    else if (Array.isArray(c)) n += countContentTokens(c as AnthropicBlock[]) + 5;
  }
  if (Array.isArray(body.tools)) n += textTokens(JSON.stringify(body.tools));
  return n;
}

export async function handle(req: IncomingMessage, res: ServerResponse, path: string, sessionId: string): Promise<boolean> {
  if (req.method === "GET" && path === "/v1/models") {
    const data = MODELS.map(modelObject);
    json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    return true;
  }

  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    const id = decodeURIComponent(path.slice("/v1/models/".length));
    const m = MODELS.find((x) => x.id === id);
    if (!m) anthropicError(res, 404, `model: ${id}`, "not_found_error");
    else json(res, 200, modelObject(m));
    return true;
  }

  if (req.method === "POST" && path === "/v1/messages/count_tokens") {
    let body: MessagesBody;
    try { body = JSON.parse(await readBody(req)) as MessagesBody; } catch { anthropicError(res, 400, "Requisição não é JSON válido."); return true; }
    const messages = Array.isArray(body.messages) ? body.messages.filter(Boolean) : null;
    if (!messages || !messages.length) {
      anthropicError(res, 400, "messages: at least one message is required");
      return true;
    }
    json(res, 200, { input_tokens: Math.max(1, countTokensBody(body)) });
    return true;
  }

  if (!(req.method === "POST" && path === "/v1/messages")) return false;

  let body: MessagesBody;
  try {
    body = JSON.parse(await readBody(req)) as MessagesBody;
  } catch {
    anthropicError(res, 400, "Requisição não é JSON válido.");
    return true;
  }

  // ----- validação local (antes de gastar quota) -----
  if (typeof body.model !== "string" || !body.model) {
    anthropicError(res, 400, "model: field required");
    return true;
  }
  if (!Number.isInteger(body.max_tokens) || (body.max_tokens as number) < 1) {
    anthropicError(res, 400, "max_tokens: field required");
    return true;
  }
  const messages = Array.isArray(body.messages) ? body.messages.filter(Boolean) : null;
  if (!messages || !messages.length) {
    anthropicError(res, 400, "messages: at least one message is required");
    return true;
  }

  const thinkingType = body.thinking?.type;
  const wantThinking = !!body.thinking && thinkingType !== "disabled";
  // grafias de effort já vistas no Claude Code e em harnesses: output_config.effort (2.x) →
  // reasoning_effort → reasoning.effort → effort → level → depth → budget_tokens.
  // A wire aceita os 5 níveis; o resolveModel valida e descarta o que não for um deles.
  const cfgEffort = (() => {
    for (const v of [body.output_config?.effort, body.reasoning_effort, body.reasoning?.effort, body.effort, body.level]) {
      if (typeof v === "string" && EFFORT_LEVELS.includes(v)) return v;
    }
    if (body.depth != null) {
      const n = typeof body.depth === "number" ? body.depth : Number(body.depth);
      if (Number.isInteger(n)) return n <= 1 ? "low" : n === 2 ? "medium" : n === 3 ? "high" : "max";
    }
    return budgetTokensToEffort(body.thinking?.budget_tokens);
  })();
  // sufixo de effort no id do modelo tem precedência sobre o esforço pedido no body
  const { id: model, effort: askedEffort } = resolveModel(body.model, cfgEffort);
  const reasoningEffort = thinkingType === "disabled" ? null : askedEffort;
  const stream = body.stream === true;
  const stops = (Array.isArray(body.stop_sequences) ? body.stop_sequences : [])
    .filter((s) => typeof s === "string" && s.length);

  let wireMessages: WireMessage[];
  try {
    wireMessages = await toWireMessages(messages);
  } catch (e) {
    anthropicError(res, 400, errMessage(e));
    return true;
  }
  if (!wireMessages.length) {
    anthropicError(res, 400, "messages: at least one message with content is required");
    return true;
  }

  const wireTools = body.tool_choice?.type === "none" ? [] : toWireTools(body.tools);
  const generateBody = buildGenerateBody({
    model,
    messages: wireMessages,
    system: systemOf(body),
    tools: wireTools,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    reasoningEffort,
  });

  // cliente sumiu (ctrl-C, timeout do harness) => cancela a geração upstream em vez de pagar por ela
  const ac = new AbortController();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimedOut = false;
  res.on("close", () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!res.writableEnded) ac.abort();
  });

  const start = Date.now();
  console.log(`[cc-proxy] (anthropic) ${body.model} → wire ${model}${reasoningEffort ? ` reasoning_effort=${reasoningEffort}` : ""}`);
  let upstream: Response;
  try {
    upstream = await callUpstream(generateBody, ac.signal, sessionId);
  } catch (e) {
    if (ac.signal.aborted) return true;
    anthropicError(res, 502, `Falha ao conectar no commandcode: ${errMessage(e)}`, "api_error");
    return true;
  }

  if (!upstream.ok) {
    const upstreamErr = await upstreamErrorMessage(upstream);
    const mapped = mapUpstreamError(upstream.status, upstreamErr);
    setRetryAfter(res, mapped.status);
    anthropicError(res, mapped.status, `commandcode: ${upstreamErr}`, mapped.type);
    return true;
  }

  // ----- estado da resposta -----
  const id = messageId();
  const content: OutBlock[] = []; // blocos finais, na ordem em que chegaram
  let finalUsage: WireUsage | null = null;
  let wireFinish = "end_turn";
  let stopSequence: string | null = null;
  let sawToolUse = false;

  const stopFilter = makeStopFilter(stops);
  const clientToolNames = new Set(wireTools.map((tool) => tool.name));
  let lastByteAt = Date.now(); // idle watchdog: renovado a cada byte do upstream e durante o re-chunk do thinking
  let thinkingPacingSpent = 0;
  const sendEvent = (type: string, data: object) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // máquina de estado dos blocos: um bloco fecha antes do próximo abrir, índices sequenciais
  let openBlock: { kind: "text" | "thinking"; index: number } | null = null;
  let nextIndex = 0;
  function closeBlock() {
    if (!openBlock) return;
    if (stream) {
      // bloco thinking fecha com signature_delta (aqui vazia: a wire não devolve assinatura)
      if (openBlock.kind === "thinking") {
        sendEvent("content_block_delta", { type: "content_block_delta", index: openBlock.index, delta: { type: "signature_delta", signature: "" } });
      }
      sendEvent("content_block_stop", { type: "content_block_stop", index: openBlock.index });
    }
    openBlock = null;
  }

  function appendText(kind: "text" | "thinking", text: string) {
    const last = content[content.length - 1];
    if (last && last.type === "text" && kind === "text") last.text += text;
    else if (last && last.type === "thinking" && kind === "thinking") last.thinking += text;
    else content.push(kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text, signature: "" });
    if (!stream) return;
    if (!openBlock || openBlock.kind !== kind) {
      closeBlock();
      openBlock = { kind, index: nextIndex++ };
      sendEvent("content_block_start", {
        type: "content_block_start",
        index: openBlock.index,
        content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" },
      });
    }
    sendEvent("content_block_delta", {
      type: "content_block_delta",
      index: openBlock.index,
      delta: kind === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
    });
  }

  // re-chunk do reasoning na saída: se a wire entregar um reasoning-delta gigante, fatiar em
  // deltas pequenos com pacing — o cliente renderiza progressivo em vez de um bloco que salta.
  async function appendThinking(text: string) {
    if (!stream || Array.from(text).length <= THINK_CHUNK) { appendText("thinking", text); return; }
    const chunks = chunkRunes(text, THINK_CHUNK);
    appendText("thinking", chunks[0]);
    for (const c of chunks.slice(1)) {
      if (thinkingPacingSpent < THINK_PACING_BUDGET) {
        lastByteAt = Date.now(); // o pacing pausa o readEvents; não confundir a pausa local com idle upstream
        await new Promise((r) => setTimeout(r, THINK_DELAY));
        thinkingPacingSpent += THINK_DELAY;
      }
      appendText("thinking", c);
    }
  }

  // O commandcode expõe os argumentos incrementalmente antes do evento final `tool-call`.
  // Para tool calls paralelas, os deltas podem se intercalar; a wire Anthropic exige blocos
  // sequenciais, então o primeiro flui ao vivo e os seguintes acumulam até o anterior fechar.
  type StreamToolInput = {
    id: string;
    name: string;
    chunks: string[];
    emitted: number;
    ended: boolean;
    index: number | null;
    streamable: boolean;
  };
  const toolInputs = new Map<string, StreamToolInput>();
  const toolInputQueue: string[] = [];
  let activeToolInput: string | null = null;

  function activateNextToolInput(): void {
    if (!stream || activeToolInput) return;
    while (toolInputQueue.length) {
      const id = toolInputQueue.shift() as string;
      const state = toolInputs.get(id);
      if (!state || !state.streamable || state.index !== null) continue;
      closeBlock();
      state.index = nextIndex++;
      activeToolInput = id;
      sendEvent("content_block_start", {
        type: "content_block_start",
        index: state.index,
        content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
      });
      while (state.emitted < state.chunks.length) {
        sendEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.index,
          delta: { type: "input_json_delta", partial_json: state.chunks[state.emitted++] },
        });
      }
      if (state.ended) {
        sendEvent("content_block_stop", { type: "content_block_stop", index: state.index });
        activeToolInput = null;
        continue;
      }
      return;
    }
  }

  function endToolInput(id: string): void {
    const state = toolInputs.get(id);
    if (!state) return;
    state.ended = true;
    if (activeToolInput === id && state.index !== null) {
      sendEvent("content_block_stop", { type: "content_block_stop", index: state.index });
      activeToolInput = null;
      activateNextToolInput();
    }
  }

  function addToolUse(ev: WireToolCallEvent) {
    let raw = ev.input ?? ev.args ?? {};
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = {}; } }
    // tool_use.input é objeto, nunca string
    const input: Record<string, unknown> = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const toolId = ev.toolCallId ?? toolUseId();
    const name = ev.toolName ?? "unknown";
    content.push({ type: "tool_use", id: toolId, name, input });
    sawToolUse = true;
    if (!stream) return;
    const incremental = toolInputs.get(toolId);
    if (incremental?.streamable) {
      if (!incremental.ended) endToolInput(toolId);
      // O bloco já foi emitido pelos eventos tool-input-*; o evento final serve como
      // fonte autoritativa para o objeto da resposta não-stream/conteúdo acumulado.
      if (incremental.index !== null) return;
    }
    closeBlock();
    const index = nextIndex++;
    sendEvent("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name, input: {} } });
    // a wire entrega o input completo de uma vez; um único delta é válido (o SDK só concatena)
    sendEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    sendEvent("content_block_stop", { type: "content_block_stop", index });
  }

  function closeToolInputs(): void {
    if (!stream) return;
    for (const state of toolInputs.values()) state.ended = true;
    if (activeToolInput) {
      const state = toolInputs.get(activeToolInput);
      if (state?.index !== null && state?.index !== undefined) {
        sendEvent("content_block_stop", { type: "content_block_stop", index: state.index });
      }
      activeToolInput = null;
    }
    activateNextToolInput();
  }

  // Anthropic nunca encerra uma mensagem bem-formada sem ao menos um content block.
  // Isso ocorre quando todo o budget foi consumido no reasoning suprimido ou quando
  // o único evento foi uma tool server-side.
  function ensureAnyContentBlock(): void {
    if (content.length) return;
    content.push({ type: "text", text: "" });
    if (!stream) return;
    closeBlock();
    const index = nextIndex++;
    sendEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    sendEvent("content_block_stop", { type: "content_block_stop", index });
  }

  function stopReason() {
    if (sawToolUse) return "tool_use";
    if (stopSequence) return "stop_sequence";
    if (wireFinish === "max_tokens" || wireFinish === "length") return "max_tokens";
    return "end_turn";
  }

  async function handleStream(readable: ReadableStream<Uint8Array>) {
    // idle watchdog por leitura: cada byte do upstream renova o deadline; nenhum byte por
    // CC_IDLE_TIMEOUT_MS = stream pendurado => cancela (em vez de pendurar a request 10 min).
    const idleTimer = setInterval(() => {
      if (Date.now() - lastByteAt >= UPSTREAM_IDLE_TIMEOUT_MS) { idleTimedOut = true; ac.abort(); }
    }, 1000);
    try {
      for await (const ev of readEvents(readable, { onChunk: () => { lastByteAt = Date.now(); } })) {
        switch (ev.type) {
          case "text-delta": {
            const { emit, hit } = stopFilter.push(ev.text ?? "");
            if (emit) appendText("text", emit);
            if (hit) { stopSequence = hit; ac.abort(); return; }
            break;
          }
          case "reasoning-delta": {
            // só vira bloco thinking se o request pediu thinking (a assinatura não é replayable)
            if (!wantThinking) break;
            const text = ev.text ?? "";
            if (text) await appendThinking(text);
            break;
          }
          case "tool-input-start": {
            if (!stream || !ev.id || !ev.toolName) break;
            const state: StreamToolInput = {
              id: ev.id,
              name: ev.toolName,
              chunks: [],
              emitted: 0,
              ended: false,
              index: null,
              // Só antecipe tools declaradas pelo cliente. Tools server-side não podem
              // vazar como tool_use antes de sabermos providerExecuted no evento final.
              streamable: clientToolNames.has(ev.toolName),
            };
            toolInputs.set(ev.id, state);
            if (state.streamable) {
              toolInputQueue.push(ev.id);
              activateNextToolInput();
            }
            break;
          }
          case "tool-input-delta": {
            if (!stream || !ev.id || typeof ev.delta !== "string") break;
            const state = toolInputs.get(ev.id);
            if (!state?.streamable) break;
            state.chunks.push(ev.delta);
            if (activeToolInput === ev.id && state.index !== null) {
              sendEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.index,
                delta: { type: "input_json_delta", partial_json: ev.delta },
              });
              state.emitted++;
            }
            break;
          }
          case "tool-input-end":
            if (stream && ev.id) endToolInput(ev.id);
            break;
          case "tool-call": {
            // tool executada pelo próprio servidor (web_search/web_fetch): não vira tool_use
            if (ev.providerExecuted === true) break;
            addToolUse(ev);
            break;
          }
          case "finish":
            finalUsage = ev.totalUsage ?? null;
            wireFinish = ev.finishReason ?? ev.rawFinishReason ?? "end_turn";
            break;
          case "error": {
            const err = ev.error;
            const message = (typeof err === "string" ? err : err?.message) ?? "erro no stream do commandcode";
            throw new StreamError(message, (typeof err === "string" ? undefined : err?.statusCode) ?? 500);
          }
          case "abort":
            throw new StreamError("geração abortada pelo commandcode", 502);
        }
      }
    } finally {
      clearInterval(idleTimer);
    }
  }

  // ---------- stream (SSE) ----------
  if (stream) {
    sseHead(res);
    // Keepalive em cadência fixa, como a Messages API real. Usar "3s desde a última
    // escrita" num timer também de 3s podia perder o primeiro tick por poucos ms e só
    // emitir aos 6s, tarde demais para intermediários com timeout curto.
    pingTimer = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
      } catch {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      }
    }, PING_MS);
    sendEvent("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null,
        // a wire só entrega usage no `finish`; o valor real vai no message_delta
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });

    try {
      await handleStream(upstream.body!);
      if (!stopSequence) {
        const tail = stopFilter.flush();
        if (tail) appendText("text", tail);
      }
      closeToolInputs();
      closeBlock();
      ensureAnyContentBlock();
      sendEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason(), stop_sequence: stopSequence },
        usage: usageOf(finalUsage),
      });
      sendEvent("message_stop", { type: "message_stop" });
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      res.end();
      console.log(`[cc-proxy] (anthropic) ${model} stream ok ${Math.round(Date.now() - start)}ms`);
    } catch (e) {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (idleTimedOut) {
        // upstream travou: erro visível no cliente em vez de stream truncado silencioso
        try {
          sendEvent("error", { type: "error", error: { type: "api_error", message: "commandcode: stream idle timeout" } });
          res.end();
        } catch {}
        console.error(`[cc-proxy] (anthropic) ${model} stream idle timeout`);
        return true;
      }
      if (ac.signal.aborted && !stopSequence) { try { res.end(); } catch {} return true; }
      // erro no meio do stream: evento `error` e encerra SEM message_stop — é o que faz o SDK
      // lançar em vez de tratar como sucesso truncado.
      const mapped = mapUpstreamError(errStatus(e), errMessage(e));
      try {
        sendEvent("error", { type: "error", error: { type: mapped.type, message: errMessage(e) } });
        res.end();
      } catch {}
      console.error(`[cc-proxy] (anthropic) ${model} stream erro: ${errMessage(e)}`);
    }
    return true;
  }

  // ---------- não-stream ----------
  try {
    await handleStream(upstream.body!);
  } catch (e) {
    if (idleTimedOut) { anthropicError(res, 504, "commandcode: stream idle timeout", "api_error"); return true; }
    if (ac.signal.aborted) return true;
    const mapped = mapUpstreamError(errStatus(e), errMessage(e));
    setRetryAfter(res, mapped.status);
    anthropicError(res, mapped.status, `commandcode: ${errMessage(e)}`, mapped.type);
    return true;
  }
  if (!stopSequence) {
    const tail = stopFilter.flush();
    if (tail) appendText("text", tail);
  }
  ensureAnyContentBlock();

  json(res, 200, {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(),
    stop_sequence: stopSequence,
    usage: usageOf(finalUsage),
  });
  console.log(`[cc-proxy] (anthropic) ${model} ok ${Math.round(Date.now() - start)}ms`);
  return true;
}
