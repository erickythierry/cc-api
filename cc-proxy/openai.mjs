// Dialeto OpenAI: /v1/chat/completions, /v1/models, /v1/models/{id}.
// Comportamento idêntico ao da versão monolítica anterior (server.mjs).

import { randomBytes } from "node:crypto";

import { MODELS, DEFAULT_MODEL, resolveModel, EFFORT_LEVELS } from "./models.mjs";
import {
  DEFAULT_SYSTEM, MAX_TOKENS,
  buildGenerateBody, callUpstream, classifyUpstreamError, contentToText,
  imageUrlToDataUri, json, makeStopFilter, readBody, readEvents, sseHead,
  toWireTools, upstreamErrorMessage,
} from "./upstream.mjs";

const BOOT = Math.floor(Date.now() / 1000);

// kind neutro do upstream -> type/code do OpenAI
const ERROR_MAP = {
  rate_limit: { type: "rate_limit_exceeded", code: "rate_limit_exceeded" },
  auth: { type: "invalid_request_error", code: "invalid_api_key" },
  permission: { type: "invalid_request_error", code: "permission_denied" },
  not_found: { type: "invalid_request_error", code: "model_not_found" },
  invalid: { type: "invalid_request_error", code: null },
  upstream: { type: "upstream_error", code: null },
};
function mapUpstreamError(status, message) {
  const { kind, status: mapped } = classifyUpstreamError(status, message);
  return { status: mapped, ...ERROR_MAP[kind] };
}

export function openAiError(res, status, message, type = "invalid_request_error", code = null, param = null) {
  json(res, status, { error: { message, type, param, code } });
}

function modelObject(m) {
  return { id: m.id, object: "model", created: BOOT, owned_by: "commandcode", context_length: m.context ?? null };
}

// ---------- conversão OpenAI -> wire do commandcode ----------
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

// ---------- handler ----------
// devolve true se tratou a rota, false se ela não é do dialeto OpenAI
export async function handle(req, res, path, sessionId) {
  if (req.method === "GET" && path === "/v1/models") {
    json(res, 200, { object: "list", data: MODELS.map(modelObject) });
    return true;
  }

  // GET /v1/models/{id}  (models.retrieve do SDK; o id tem "/" dentro)
  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    const id = decodeURIComponent(path.slice("/v1/models/".length));
    const m = MODELS.find((x) => x.id === id);
    if (!m) openAiError(res, 404, `The model '${id}' does not exist`, "invalid_request_error", "model_not_found", "model");
    else json(res, 200, modelObject(m));
    return true;
  }

  if (!(req.method === "POST" && path === "/v1/chat/completions")) return false;

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    openAiError(res, 400, "Requisição não é JSON válido.");
    return true;
  }

  // ----- validação local (mesmos erros que a API OpenAI devolve antes de gastar quota) -----
  const messages = Array.isArray(body.messages) ? body.messages.filter(Boolean) : null;
  if (!messages || messages.length === 0) {
    openAiError(res, 400, "you must provide a 'messages' parameter with at least one message", "invalid_request_error", null, "messages");
    return true;
  }
  if (body.n != null && Number(body.n) !== 1) {
    openAiError(res, 400, "n > 1 não é suportado por este proxy (o upstream do commandcode gera uma resposta por request)", "invalid_request_error", null, "n");
    return true;
  }

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
    openAiError(res, 400, e.message);
    return true;
  }
  if (!wireMessages.length) {
    openAiError(res, 400, "nenhuma mensagem com conteúdo além de system/developer", "invalid_request_error", null, "messages");
    return true;
  }

  const generateBody = buildGenerateBody({
    model,
    messages: wireMessages,
    system,
    tools: body.tool_choice === "none" ? [] : toWireTools(body.tools),
    maxTokens: body.max_completion_tokens ?? body.max_tokens ?? MAX_TOKENS,
    temperature: body.temperature,
    topP: body.top_p,
    reasoningEffort,
  });

  // cliente sumiu (ctrl-C, timeout do harness) => cancela a geração upstream em vez de pagar por ela
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  const start = Date.now();
  console.log(`[cc-proxy] ${requestedModel} → wire ${model}${reasoningEffort ? ` reasoning_effort=${reasoningEffort}` : ""}`);
  let upstream;
  try {
    upstream = await callUpstream(generateBody, ac.signal, sessionId);
  } catch (e) {
    if (ac.signal.aborted) return true;
    openAiError(res, 502, `Falha ao conectar no commandcode: ${e.message}`, "upstream_error");
    return true;
  }

  if (!upstream.ok) {
    const upstreamErr = await upstreamErrorMessage(upstream);
    const mapped = mapUpstreamError(upstream.status, upstreamErr);
    openAiError(res, mapped.status, `commandcode: ${upstreamErr}`, mapped.type, mapped.code);
    return true;
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
    sseHead(res);

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
      if (ac.signal.aborted && !stoppedBySequence) { try { res.end(); } catch {} return true; }
      // erro no meio do stream: evento `error` e encerra SEM [DONE] — é assim que a OpenAI
      // sinaliza falha parcial, e é o que faz o SDK lançar em vez de tratar como sucesso.
      const mapped = mapUpstreamError(e.statusCode ?? 500, e.message);
      try {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: mapped.type, param: null, code: mapped.code } })}\n\n`);
        res.end();
      } catch {}
      console.error(`[cc-proxy] ${model} stream erro: ${e.message}`);
    }
    return true;
  }

  // ---------- não-stream ----------
  try {
    await handleStream(upstream.body);
  } catch (e) {
    if (ac.signal.aborted) return true;
    const mapped = mapUpstreamError(e.statusCode ?? 500, e.message);
    openAiError(res, mapped.status, `commandcode: ${e.message}`, mapped.type, mapped.code);
    return true;
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
  return true;
}
