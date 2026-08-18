#!/usr/bin/env node
// commandcode-openai-proxy — expõe a API do commandcode (api.commandcode.ai) no formato OpenAI.
// Sem auth local. Só converte o wire. Ver README.md.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";

import { MODELS, DEFAULT_MODEL, resolveModel, EFFORT_LEVELS } from "./models.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const API_BASE = process.env.COMMANDCODE_API_URL || "https://api.commandcode.ai";
const API_VERSION = process.env.COMMANDCODE_API_VERSION || "1.27.1";
const MAX_TOKENS = 64000; // default max_tokens do CLI

// ---------- auth ----------
function getKey() {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY.trim();
  try {
    const raw = readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8");
    return JSON.parse(raw).apiKey ?? null;
  } catch {
    return null;
  }
}
const API_KEY = getKey();
if (!API_KEY) {
  console.error("[cc-proxy] Sem API key. Export COMMAND_CODE_API_KEY ou rode `command-code login`.");
  process.exit(1);
}

// ---------- config do servidor do commandcode (buildServerConfig do CLI) ----------
function git(args) {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function buildServerConfig() {
  const isGit = !!git(["rev-parse", "--git-dir"]);
  const cwd = process.cwd();
  const structure = readdirSync(cwd).filter((f) => !f.startsWith(".")).sort();
  const branches = git(["branch", "-r"]) ?? "";
  return {
    workingDir: cwd,
    date: new Date().toISOString().split("T")[0],
    environment: platform(),
    structure,
    isGitRepo: isGit,
    currentBranch: isGit ? (git(["branch", "--show-current"]) ?? "") : "",
    mainBranch: isGit ? (branches.includes("origin/main") ? "main" : branches.includes("origin/master") ? "master" : "main") : "",
    gitStatus: isGit ? (git(["status", "--porcelain"]) || "Working tree clean") : "",
    recentCommits: isGit ? (git(["log", "--oneline", "-3"])?.split("\n") ?? []) : [],
  };
}
const SERVER_CONFIG = buildServerConfig();

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
  // data URI: passa direto
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (m) {
      const mime = m[1] || "image/png";
      const base64 = m[2] ? m[3] : Buffer.from(m[3], "utf8").toString("base64");
      return { image: `data:${mime};base64,${base64}`, mimeType: mime };
    }
  }
  throw new Error("Imagem fora do padrão: só aceita data URI (base64).");
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
          else if (p.type === "image_url") {
            const img = await imageUrlToDataUri(p.image_url?.url ?? "");
            parts.push({ type: "image", ...img });
          }
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
      wire.push({ role: "assistant", content: parts });
      continue;
    }
    if (role === "tool") {
      const output = {
        type: "text",
        value: typeof msg.content === "string" ? msg.content : contentToText(msg.content),
      };
      wire.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id ?? "",
          toolName: toolName.get(msg.tool_call_id) ?? "unknown",
          output,
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
    .filter(Boolean)
    .map((fn) => ({
      name: fn.name,
      description: fn.description ?? "",
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    }));
}

// ---------- conversão wire do commandcode -> OpenAI ----------
function chatId() { return `chatcmpl-${randomBytes(12).toString("hex")}`; }

function finishReason(wireFinish) {
  if (wireFinish === "tool-calls") return "tool_calls";
  if (wireFinish === "length" || wireFinish === "max_tokens") return "length";
  return "stop";
}

function usageOf(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: u.inputTokens ?? 0,
    completion_tokens: u.outputTokens ?? 0,
    total_tokens: u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0)),
  };
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

function openAiError(res, status, message, type = "invalid_request_error", code = null) {
  json(res, status, { error: { message, type, param: null, code } });
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
    json(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "commandcode",
        context_length: m.context ?? null,
      })),
    });
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

    const requestedModel = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    const { id: model, effort: modelEffort } = resolveModel(requestedModel);
    // reasoning_effort explícito no body (OpenAI padrão) só vale se o id do modelo não já fixou via sufixo
    const bodyEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort.toLowerCase() : null;
    const reasoningEffort = modelEffort ?? (EFFORT_LEVELS.includes(bodyEffort) ? bodyEffort : null);
    const stream = body.stream === true;
    const includeUsage = body.stream_options?.include_usage === true;
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // system: junta roles system/developer
    const system = messages
      .filter((m) => m?.role === "system" || m?.role === "developer")
      .map((m) => (typeof m.content === "string" ? m.content : contentToText(m.content)))
      .filter(Boolean)
      .join("\n");

    let wireMessages;
    try {
      wireMessages = await toWireMessages(messages);
    } catch (e) {
      return openAiError(res, 400, e.message);
    }

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
        tools: toWireTools(body.tools),
        ...(system ? { system } : {}),
        max_tokens: body.max_tokens ?? body.max_completion_tokens ?? MAX_TOKENS,
        stream: true,
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
    };

    const start = Date.now();
    console.log(`[cc-proxy] ${requestedModel} → wire ${model}${reasoningEffort ? ` reasoning_effort=${reasoningEffort}` : ""}`);
    const headers = authHeaders(sessionId);
    let upstream;
    try {
      upstream = await fetch(`${API_BASE}/alpha/generate`, {
        method: "POST",
        headers,
        body: JSON.stringify(generateBody),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (e) {
      return openAiError(res, 502, `Falha ao conectar no commandcode: ${e.message}`, "upstream_error");
    }

    if (!upstream.ok) {
      let upstreamErr = "erro do commandcode";
      try { upstreamErr = (await upstream.json()).error?.message ?? upstreamErr; } catch {}
      return openAiError(res, 502, `commandcode: ${upstreamErr}`, "upstream_error", String(upstream.status));
    }

    // ----- parse do stream NDJSON do commandcode -----
    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    const textParts = [];
    const toolCalls = []; // {index, id, name, arguments}
    let finalUsage = null;
    let wireFinish = "stop";

    const base = { id, object: "chat.completion.chunk", created, model };
    const sendChunk = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    // consome o NDJSON do commandcode: atualiza estado e, se stream, emite SSE
    async function handleStream(readable) {
      let sentRole = false;
      for await (const ev of readEvents(readable)) {
        switch (ev.type) {
          case "text-delta":
            textParts.push(ev.text ?? "");
            if (!stream) break;
            if (!sentRole) { sendChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }); sentRole = true; }
            sendChunk({ ...base, choices: [{ index: 0, delta: { content: ev.text ?? "" }, finish_reason: null }] });
            break;
          case "tool-call": {
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
            if (!sentRole) { sendChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }); sentRole = true; }
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
            wireFinish = ev.rawFinishReason ?? ev.finishReason ?? "stop";
            break;
          case "error": {
            const err = new Error(ev.error?.message ?? ev.error ?? "erro no stream");
            err.statusCode = ev.error?.statusCode ?? 500;
            throw err;
          }
          case "abort": throw new Error("stream abortado");
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

        const fr = toolCalls.length ? "tool_calls" : finishReason(wireFinish);
        sendChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: fr }] });
        if (includeUsage) {
          sendChunk({ ...base, choices: [], usage: usageOf(finalUsage) });
        }
        res.write("data: [DONE]\n\n");
        res.end();
        console.log(`[cc-proxy] ${model} stream ok ${Math.round(Date.now() - start)}ms`);
      } catch (e) {
        // erro no meio do stream: envia chunk de erro e encerra
        try {
          sendChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          sendChunk({ ...base, choices: [], error: { message: e.message } });
          res.write("data: [DONE]\n\n");
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
      return openAiError(res, 502, e.message, "upstream_error", e.statusCode ?? null);
    }

    const content = textParts.join("");
    const usage = usageOf(finalUsage);
    const fr = toolCalls.length ? "tool_calls" : finishReason(wireFinish);
    const choice = {
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      },
      logprobs: null,
      finish_reason: fr,
    };
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [choice],
      usage,
    });
    console.log(`[cc-proxy] ${model} ok ${Math.round(Date.now() - start)}ms`);
    return;
  }

  openAiError(res, 404, `Endpoint não encontrado: ${req.method} ${path}`);
});

server.listen(PORT, () => {
  console.log(`[cc-proxy] OpenAI-compatible em http://localhost:${PORT}`);
  console.log(`[cc-proxy] modelo default: ${DEFAULT_MODEL} | upstream: ${API_BASE}`);
});
