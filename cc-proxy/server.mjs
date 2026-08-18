#!/usr/bin/env node
// commandcode-openai-proxy — expõe a API do commandcode (api.commandcode.ai) no formato OpenAI.
// Sem auth local, bind em loopback. Só converte o wire. Ver README.md.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

import { MODELS, DEFAULT_MODEL, resolveModel, EFFORT_LEVELS } from "./models.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1"; // key sem auth: loopback por padrão
const API_BASE = process.env.COMMANDCODE_API_URL || "https://api.commandcode.ai";
const API_VERSION = process.env.COMMANDCODE_API_VERSION || "1.27.1";
const MAX_TOKENS = 64000; // default max_tokens do CLI
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Sem `system` no request, o upstream injeta o prompt de agente do CLI (~7.6k tokens de input
// e o modelo passa a se apresentar como agente de terminal). Um system mínimo evita os dois.
const DEFAULT_SYSTEM = process.env.CC_DEFAULT_SYSTEM || "You are a helpful assistant.";

// ---------- auth ----------
function getKey() {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY.trim();
  try {
    return JSON.parse(readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8")).apiKey ?? null;
  } catch {
    return null;
  }
}
const API_KEY = getKey();
if (!API_KEY) {
  console.error("[cc-proxy] Sem API key. Export COMMAND_CODE_API_KEY ou rode `command-code login`.");
  process.exit(1);
}

// `config` é obrigatório na wire (Zod server-side), mas o conteúdo só alimenta o prompt de
// agente do CLI — que não usamos. Mandamos o mínimo válido em vez de vazar cwd/git do usuário.
const SERVER_CONFIG = {
  workingDir: "/",
  date: new Date().toISOString().split("T")[0],
  environment: "linux",
  structure: [],
  isGitRepo: false,
  currentBranch: "",
  mainBranch: "",
  gitStatus: "",
  recentCommits: [],
};

// ---------- headers padrão (buildCommandAuthHeaders do CLI) ----------
function authHeaders(sessionId) {
  return {
    "Content-Type": "application/json",
    "User-Agent": "cli",
    Authorization: `Bearer ${API_KEY}`,
    "x-command-code-version": API_VERSION,
    "x-cli-environment": "production",
    "x-project-slug": "cc-proxy",
    "x-taste-learning": "false",
    "x-co-flag": "false",
    "x-session-id": sessionId,
  };
}

// ---------- conversão OpenAI -> wire do commandcode ----------
// OpenAI messages:
//   {role:"system"|"developer", content:string}            -> system (juntado)
//   {role:"user", content:string|[{type:"text"|"image_url",...}]}
//   {role:"assistant", content|null, tool_calls:[{id,function:{name,arguments}}]}
//   {role:"tool", tool_call_id, content}
// Wire:
//   system: string separado
//   user:   {role:"user", content:[{type:"text",text} | {type:"image",image:"data:...",mimeType}]}
//   assistant: {role:"assistant", content:[{type:"text",text} | {type:"tool-call",toolCallId,toolName,input}]}
//   tool:   {role:"tool", content:[{type:"tool-result",toolCallId,toolName,output:{type:"text",value}}]}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

async function imageUrlToDataUri(url) {
  if (!url) throw new Error("image_url.url ausente.");
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new Error("data URI de imagem malformado.");
    const mime = m[1] || "image/png";
    const base64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), "utf8").toString("base64");
    return { image: `data:${mime};base64,${base64}`, mimeType: mime };
  }
  if (!/^https?:\/\//.test(url)) throw new Error("image_url.url precisa ser http(s) ou data URI.");
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Falha ao baixar imagem (${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("Imagem maior que 20MB.");
  const mime = (r.headers.get("content-type") || "image/png").split(";")[0].trim();
  return { image: `data:${mime};base64,${buf.toString("base64")}`, mimeType: mime };
}

// monta mapa tool_call_id -> nome a partir de mensagens assistant anteriores
function buildToolNameMap(messages) {
  const map = new Map();
  for (const msg of messages) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id && tc?.function?.name) map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

async function toWireMessages(messages) {
  const toolName = buildToolNameMap(messages);
  const wire = [];
  for (const msg of messages) {
    if (!msg) continue;
    const role = msg.role;
    if (role === "system" || role === "developer") continue; // vai pro campo system
    if (role === "user") {
      const parts = [];
      if (typeof msg.content === "string") {
        if (msg.content) parts.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (!p) continue;
          if (p.type === "text") parts.push({ type: "text", text: p.text ?? "" });
          else if (p.type === "image_url") parts.push({ type: "image", ...(await imageUrlToDataUri(p.image_url?.url ?? "")) });
        }
      }
      if (parts.length) wire.push({ role: "user", content: parts });
      continue;
    }
    if (role === "assistant") {
      const parts = [];
      if (typeof msg.content === "string" && msg.content) {
        parts.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p?.type === "text" && p.text) parts.push({ type: "text", text: p.text });
        }
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input;
          try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
          catch { input = { _raw: tc.function?.arguments }; }
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function?.name ?? "unknown",
            input,
          });
        }
      }
      // assistant vazio (ex.: content:null sem tool_calls) quebra a validação da wire
      if (parts.length) wire.push({ role: "assistant", content: parts });
      continue;
    }
    if (role === "tool") {
      wire.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id ?? "",
          toolName: msg.name ?? toolName.get(msg.tool_call_id) ?? "unknown",
          output: { type: "text", value: typeof msg.content === "string" ? msg.content : contentToText(msg.content) },
        }],
      });
      continue;
    }
    // role desconhecido: vira texto de user
    const text = typeof msg.content === "string" ? msg.content : contentToText(msg.content);
    if (text) wire.push({ role: "user", content: [{ type: "text", text }] });
  }
  return wire;
}

function toWireTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => t?.function ?? t)
    .filter((fn) => fn?.name)
    .map((fn) => ({
      name: fn.name,
      description: fn.description ?? "",
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    }));
}

// A wire não expõe response_format nem tool_choice; viram instrução no system (best-effort,
// mesmo caminho que LiteLLM usa para provedores sem suporte nativo).
function extraSystemInstructions(body) {
  const out = [];
  const rf = body.response_format;
  if (rf?.type === "json_object") {
    out.push("Responda EXCLUSIVAMENTE com um único objeto JSON válido. Sem texto fora do JSON, sem blocos de markdown.");
  } else if (rf?.type === "json_schema") {
    const schema = rf.json_schema?.schema ?? rf.json_schema;
    out.push(
      "Responda EXCLUSIVAMENTE com um único objeto JSON válido que satisfaça este JSON Schema. " +
      "Sem texto fora do JSON, sem blocos de markdown.\nSchema:\n" + JSON.stringify(schema)
    );
  }
  const tc = body.tool_choice;
  if (tc === "required") out.push("Você DEVE chamar pelo menos uma das ferramentas disponíveis nesta resposta.");
  else if (tc?.type === "function" && tc.function?.name) out.push(`Você DEVE chamar a ferramenta \`${tc.function.name}\` nesta resposta.`);
  return out;
}

// ---------- conversão wire do commandcode -> OpenAI ----------
function chatId() { return `chatcmpl-${randomBytes(12).toString("hex")}`; }

function finishReasonOf(wireFinish) {
  switch (wireFinish) {
    case "tool-calls": case "tool_calls": return "tool_calls";
    case "length": case "max_tokens": return "length";
    case "content-filter": case "content_filter": return "content_filter";
    default: return "stop";
  }
}

function usageOf(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = u.inputTokens ?? 0;
  const completion = u.outputTokens ?? 0;
  const cached = u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? 0;
  const reasoning = u.reasoningTokens ?? u.outputTokenDetails?.reasoningTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.totalTokens ?? prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

// stop sequences: a wire não suporta, então cortamos aqui (e abortamos o upstream ao cortar).
function makeStopFilter(stops) {
  const maxLen = stops.reduce((a, s) => Math.max(a, s.length), 0);
  let pending = "";
  return {
    push(text) {
      if (!stops.length) return { emit: text, hit: false };
      pending += text;
      let hitIdx = -1;
      for (const s of stops) {
        const i = pending.indexOf(s);
        if (i !== -1 && (hitIdx === -1 || i < hitIdx)) hitIdx = i;
      }
      if (hitIdx !== -1) { const emit = pending.slice(0, hitIdx); pending = ""; return { emit, hit: true }; }
      const keep = Math.max(0, maxLen - 1);
      const emit = pending.slice(0, Math.max(0, pending.length - keep));
      pending = pending.slice(emit.length);
      return { emit, hit: false };
    },
    flush() { const e = pending; pending = ""; return e; },
  };
}

// ---------- mapeamento de erro upstream -> erro OpenAI ----------
function mapUpstreamError(status, message) {
  const m = String(message || "").toLowerCase();
  if (/rate limit|usage window|too many requests|insufficient credits|credits_exhausted|credits exhausted/.test(m) || status === 429)
    return { status: 429, type: "rate_limit_exceeded", code: "rate_limit_exceeded" };
  if (/model_not_in_plan|not recognized|model not found|unknown model/.test(m))
    return { status: 404, type: "invalid_request_error", code: "model_not_found" };
  if (status === 401 || /invalid .*authorization|unauthorized|invalid api key/.test(m))
    return { status: 401, type: "invalid_request_error", code: "invalid_api_key" };
  if (status === 403) return { status: 403, type: "invalid_request_error", code: "permission_denied" };
  if (status >= 400 && status < 500) return { status, type: "invalid_request_error", code: null };
  return { status: 502, type: "upstream_error", code: null };
}

// ---------- servidor ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// lê o stream NDJSON do commandcode e entrega cada linha parseada
async function* readEvents(readable) {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { yield JSON.parse(line); } catch {}
      }
    }
    // última linha sem \n final (traz o `finish` com usage se o upstream não fechar com newline)
    if (buf.trim()) { try { yield JSON.parse(buf); } catch {} }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function openAiError(res, status, message, type = "invalid_request_error", code = null, param = null) {
  json(res, status, { error: { message, type, param, code } });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const sessionId = randomUUID();

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // GET /v1/models
  if (req.method === "GET" && path === "/v1/models") {
    json(res, 200, { object: "list", data: MODELS.map(modelObject) });
    return;
  }

  // GET /v1/models/{id}  (models.retrieve do SDK; o id tem "/" dentro)
  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    const id = decodeURIComponent(path.slice("/v1/models/".length));
    const m = MODELS.find((x) => x.id === id);
    if (!m) return openAiError(res, 404, `The model '${id}' does not exist`, "invalid_request_error", "model_not_found", "model");
    json(res, 200, modelObject(m));
    return;
  }

  // healthz
  if (req.method === "GET" && path === "/healthz") {
    json(res, 200, { ok: true, model: DEFAULT_MODEL });
    return;
  }

  // POST /v1/chat/completions
  if (req.method === "POST" && path === "/v1/chat/completions") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return openAiError(res, 400, "Requisição não é JSON válido.");
    }

    // ----- validação local (mesmos erros que a API OpenAI devolve antes de gastar quota) -----
    const messages = Array.isArray(body.messages) ? body.messages.filter(Boolean) : null;
    if (!messages || messages.length === 0)
      return openAiError(res, 400, "you must provide a 'messages' parameter with at least one message", "invalid_request_error", null, "messages");
    if (body.n != null && Number(body.n) !== 1)
      return openAiError(res, 400, "n > 1 não é suportado por este proxy (o upstream do commandcode gera uma resposta por request)", "invalid_request_error", null, "n");

    const requestedModel = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    const { id: model, effort: modelEffort } = resolveModel(requestedModel);
    // reasoning_effort explícito no body (OpenAI padrão) só vale se o id do modelo não já fixou via sufixo
    const bodyEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort.toLowerCase() : null;
    const reasoningEffort = modelEffort ?? (EFFORT_LEVELS.includes(bodyEffort) ? bodyEffort : null);
    const stream = body.stream === true;
    const includeUsage = body.stream_options?.include_usage === true;
    const stops = (typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop : [])
      .filter((s) => typeof s === "string" && s.length);

    // system: junta roles system/developer + instruções derivadas de response_format/tool_choice
    const system = [
      ...messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => (typeof m.content === "string" ? m.content : contentToText(m.content)))
        .filter(Boolean),
      ...extraSystemInstructions(body),
    ].join("\n\n") || DEFAULT_SYSTEM;

    let wireMessages;
    try {
      wireMessages = await toWireMessages(messages);
    } catch (e) {
      return openAiError(res, 400, e.message);
    }
    if (!wireMessages.length)
      return openAiError(res, 400, "nenhuma mensagem com conteúdo além de system/developer", "invalid_request_error", null, "messages");

    const generateBody = {
      config: SERVER_CONFIG,
      memory: null,
      taste: null,
      skills: null,
      permissionMode: "standard",
      threadId: randomUUID(),
      mode: "agent",
      params: {
        model,
        messages: wireMessages,
        tools: body.tool_choice === "none" ? [] : toWireTools(body.tools),
        system,
        max_tokens: body.max_completion_tokens ?? body.max_tokens ?? MAX_TOKENS,
        stream: true,
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
    };

    // cliente sumiu (ctrl-C, timeout do harness) => cancela a geração upstream em vez de pagar por ela
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });

    const start = Date.now();
    console.log(`[cc-proxy] ${requestedModel} → wire ${model}${reasoningEffort ? ` reasoning_effort=${reasoningEffort}` : ""}`);
    let upstream;
    try {
      upstream = await fetch(`${API_BASE}/alpha/generate`, {
        method: "POST",
        headers: authHeaders(sessionId),
        body: JSON.stringify(generateBody),
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(10 * 60 * 1000)]),
      });
    } catch (e) {
      if (ac.signal.aborted) return;
      return openAiError(res, 502, `Falha ao conectar no commandcode: ${e.message}`, "upstream_error");
    }

    if (!upstream.ok) {
      let upstreamErr = `HTTP ${upstream.status}`;
      try {
        const j = await upstream.json();
        upstreamErr = j.error?.message ?? j.message ?? upstreamErr;
      } catch {}
      const mapped = mapUpstreamError(upstream.status, upstreamErr);
      return openAiError(res, mapped.status, `commandcode: ${upstreamErr}`, mapped.type, mapped.code);
    }

    // ----- parse do stream NDJSON do commandcode -----
    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    const textParts = [];
    const reasoningParts = [];
    const toolCalls = []; // {index, id, name, arguments}
    let finalUsage = null;
    let wireFinish = "stop";
    let stoppedBySequence = false;

    const base = { id, object: "chat.completion.chunk", created, model, system_fingerprint: null };
    const sendChunk = (chunk) => res.write(`data: ${JSON.stringify(includeUsage ? { usage: null, ...chunk } : chunk)}\n\n`);
    const stopFilter = makeStopFilter(stops);
    let sentRole = false;
    const ensureRole = () => {
      if (sentRole || !stream) return;
      sendChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      sentRole = true;
    };

    // consome o NDJSON do commandcode: atualiza estado e, se stream, emite SSE
    async function handleStream(readable) {
      for await (const ev of readEvents(readable)) {
        switch (ev.type) {
          case "text-delta": {
            const { emit, hit } = stopFilter.push(ev.text ?? "");
            if (emit) {
              textParts.push(emit);
              if (stream) { ensureRole(); sendChunk({ ...base, choices: [{ index: 0, delta: { content: emit }, finish_reason: null }] }); }
            }
            if (hit) { stoppedBySequence = true; wireFinish = "stop"; ac.abort(); return; }
            break;
          }
          case "reasoning-delta": {
            const text = ev.text ?? "";
            if (!text) break;
            reasoningParts.push(text);
            if (stream) { ensureRole(); sendChunk({ ...base, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] }); }
            break;
          }
          case "tool-call": {
            // tool executada pelo próprio servidor (web_search/web_fetch): o resultado já vem
            // no stream, o cliente não tem como executá-la — não pode virar tool_call OpenAI.
            if (ev.providerExecuted === true) break;
            const idx = toolCalls.length;
            const input = ev.input ?? ev.args ?? {};
            const tc = {
              index: idx,
              id: ev.toolCallId ?? `call_${idx}`,
              name: ev.toolName ?? "unknown",
              arguments: typeof input === "string" ? input : JSON.stringify(input),
            };
            toolCalls.push(tc);
            if (!stream) break;
            ensureRole();
            sendChunk({
              ...base,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: tc.index,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                  }],
                },
                finish_reason: null,
              }],
            });
            break;
          }
          case "finish":
            finalUsage = ev.totalUsage ?? null;
            wireFinish = ev.finishReason ?? ev.rawFinishReason ?? "stop";
            break;
          case "error": {
            const err = new Error(ev.error?.message ?? (typeof ev.error === "string" ? ev.error : "erro no stream do commandcode"));
            err.statusCode = ev.error?.statusCode ?? 500;
            throw err;
          }
          case "abort": {
            const err = new Error("geração abortada pelo commandcode");
            err.statusCode = 502;
            throw err;
          }
        }
      }
    }

    // ---------- stream (SSE) ----------
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      try {
        await handleStream(upstream.body);
        const tail = stopFilter.flush();
        if (tail && !stoppedBySequence) {
          textParts.push(tail);
          ensureRole();
          sendChunk({ ...base, choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] });
        }
        ensureRole();
        const fr = toolCalls.length ? "tool_calls" : finishReasonOf(wireFinish);
        sendChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: fr }] });
        if (includeUsage) sendChunk({ ...base, choices: [], usage: usageOf(finalUsage) });
        res.write("data: [DONE]\n\n");
        res.end();
        console.log(`[cc-proxy] ${model} stream ok ${Math.round(Date.now() - start)}ms`);
      } catch (e) {
        if (ac.signal.aborted && !stoppedBySequence) { try { res.end(); } catch {} return; }
        // erro no meio do stream: evento `error` e encerra SEM [DONE] — é assim que a OpenAI
        // sinaliza falha parcial, e é o que faz o SDK lançar em vez de tratar como sucesso.
        const mapped = mapUpstreamError(e.statusCode ?? 500, e.message);
        try {
          res.write(`data: ${JSON.stringify({ error: { message: e.message, type: mapped.type, param: null, code: mapped.code } })}\n\n`);
          res.end();
        } catch {}
        console.error(`[cc-proxy] ${model} stream erro: ${e.message}`);
      }
      return;
    }

    // ---------- não-stream ----------
    try {
      await handleStream(upstream.body);
    } catch (e) {
      if (ac.signal.aborted) return;
      const mapped = mapUpstreamError(e.statusCode ?? 500, e.message);
      return openAiError(res, mapped.status, `commandcode: ${e.message}`, mapped.type, mapped.code);
    }
    if (!stoppedBySequence) textParts.push(stopFilter.flush());

    const content = textParts.join("");
    const reasoning = reasoningParts.join("");
    const fr = toolCalls.length ? "tool_calls" : finishReasonOf(wireFinish);
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length
            ? { tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) }
            : {}),
        },
        logprobs: null,
        finish_reason: fr,
      }],
      usage: usageOf(finalUsage),
    });
    console.log(`[cc-proxy] ${model} ok ${Math.round(Date.now() - start)}ms`);
    return;
  }

  openAiError(res, 404, `Endpoint não encontrado: ${req.method} ${path}`, "invalid_request_error", "unknown_url");
});

const BOOT = Math.floor(Date.now() / 1000);
function modelObject(m) {
  return { id: m.id, object: "model", created: BOOT, owned_by: "commandcode", context_length: m.context ?? null };
}

server.listen(PORT, HOST, () => {
  console.log(`[cc-proxy] OpenAI-compatible em http://${HOST}:${PORT}`);
  console.log(`[cc-proxy] modelo default: ${DEFAULT_MODEL} | upstream: ${API_BASE}`);
});
