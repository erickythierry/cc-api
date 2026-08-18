#!/usr/bin/env node
// cc-proxy — expõe a API do commandcode (api.commandcode.ai) nos dialetos OpenAI e Anthropic.
// Sem auth local, bind em loopback. Só converte o wire. Ver README.md.

import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

import { DEFAULT_MODEL } from "./models.ts";
import { API_BASE, API_KEY, json } from "./upstream.ts";
import * as openai from "./openai.ts";
import * as anthropic from "./anthropic.ts";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1"; // key sem auth: loopback por padrão

type Dialect = "openai" | "anthropic";

if (!API_KEY) {
  console.error("[cc-proxy] Sem API key. Export COMMAND_CODE_API_KEY ou rode `command-code login`.");
  process.exit(1);
}

// `/v1/messages` só existe no Anthropic e `/v1/chat/completions` só no OpenAI; o conflito é
// `/v1/models`, que existe nos dois com shapes diferentes. Prefixo explícito decide; sem
// prefixo, header de request Anthropic (`anthropic-version`/`x-api-key`) decide.
function pickDialect(req: IncomingMessage, path: string): Dialect {
  if (path === "/v1/messages" || path.startsWith("/v1/messages/")) return "anthropic";
  if (path === "/v1/chat/completions" || path === "/v1/completions") return "openai";
  if (req.headers["anthropic-version"] || req.headers["x-api-key"]) return "anthropic";
  return "openai";
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  let path = url.pathname;
  const sessionId = randomUUID();

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    });
    res.end();
    return;
  }

  // healthz (comum aos dois dialetos)
  if (req.method === "GET" && path === "/healthz") {
    json(res, 200, { ok: true, model: DEFAULT_MODEL });
    return;
  }

  // prefixos determinísticos: os dois SDKs montam `${baseURL}/v1/...`
  let forced: Dialect | null = null;
  if (path === "/openai" || path.startsWith("/openai/")) { forced = "openai"; path = path.slice("/openai".length) || "/"; }
  else if (path === "/anthropic" || path.startsWith("/anthropic/")) { forced = "anthropic"; path = path.slice("/anthropic".length) || "/"; }

  const dialect = forced ?? pickDialect(req, path);
  const handled = dialect === "anthropic"
    ? await anthropic.handle(req, res, path, sessionId)
    : await openai.handle(req, res, path, sessionId);
  if (handled) return;

  if (dialect === "anthropic") anthropic.anthropicError(res, 404, `Endpoint não encontrado: ${req.method} ${path}`, "not_found_error");
  else openai.openAiError(res, 404, `Endpoint não encontrado: ${req.method} ${path}`, "invalid_request_error", "unknown_url");
});

server.listen(PORT, HOST, () => {
  console.log(`[cc-proxy] OpenAI + Anthropic compatible em http://${HOST}:${PORT}`);
  console.log(`[cc-proxy] modelo default: ${DEFAULT_MODEL} | upstream: ${API_BASE}`);
});
