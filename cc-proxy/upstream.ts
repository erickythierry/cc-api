// Camada comum aos dois dialetos (OpenAI e Anthropic): auth, conversões neutras, wire do
// commandcode (POST /alpha/generate) e utilidades de HTTP. Nada aqui conhece o formato de
// request/resposta de nenhum dos dois dialetos.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const API_BASE = process.env.COMMANDCODE_API_URL || "https://api.commandcode.ai";
export const API_VERSION = process.env.COMMANDCODE_API_VERSION || "1.27.1";
export const MAX_TOKENS = 64000; // default max_tokens do CLI
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Sem `system` no request, o upstream injeta o prompt de agente do CLI (~7.6k tokens de input
// e o modelo passa a se apresentar como agente de terminal). Um system mínimo evita os dois.
export const DEFAULT_SYSTEM = process.env.CC_DEFAULT_SYSTEM || "You are a helpful assistant.";
export const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- tipos da wire ----------
export interface WireImage { image: string; mimeType: string }

export type WirePart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mimeType: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } };

export interface WireMessage {
  role: "user" | "assistant" | "tool";
  content: WirePart[];
}

export interface WireTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface WireUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}

export type WireToolCallEvent = {
  type: "tool-call";
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  providerExecuted?: boolean;
};

// eventos NDJSON do /alpha/generate (só os que o proxy consome; o resto cai no default)
export type WireEvent =
  | { type: "text-delta"; text?: string }
  | { type: "reasoning-delta"; text?: string }
  | WireToolCallEvent
  | { type: "tool-result"; toolCallId?: string; toolName?: string; output?: unknown }
  | { type: "finish"; finishReason?: string; rawFinishReason?: string; totalUsage?: WireUsage | null }
  | { type: "error"; error?: { message?: string; statusCode?: number } | string }
  | { type: "abort" }
  | { type: "start" | "start-step" | "finish-step" | "reasoning-start" | "reasoning-end" };

// erro carregando o status HTTP a repassar (usado nos eventos `error`/`abort` do stream)
export class StreamError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function errStatus(e: unknown): number {
  return e instanceof StreamError ? e.statusCode : 500;
}

// ---------- auth ----------
function getKey(): string | null {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY.trim();
  try {
    return JSON.parse(readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8")).apiKey ?? null;
  } catch {
    return null;
  }
}
export const API_KEY = getKey();

// `config` é obrigatório na wire (Zod server-side), mas o conteúdo só alimenta o prompt de
// agente do CLI — que não usamos. Mandamos o mínimo válido em vez de vazar cwd/git do usuário.
export const SERVER_CONFIG = {
  workingDir: "/",
  date: new Date().toISOString().split("T")[0],
  environment: "linux",
  structure: [] as string[],
  isGitRepo: false,
  currentBranch: "",
  mainBranch: "",
  gitStatus: "",
  recentCommits: [] as string[],
};

// ---------- headers padrão (buildCommandAuthHeaders do CLI) ----------
export function authHeaders(sessionId: string): Record<string, string> {
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

// ---------- conversões neutras ----------
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

export async function imageUrlToDataUri(url: string): Promise<WireImage> {
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

// tools: aceita o shape OpenAI ({type:"function",function:{...}}) e o Anthropic
// ({name,description,input_schema}) — que já é o shape da wire.
export function toWireTools(tools: unknown): WireTool[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => t?.function ?? t)
    .filter((fn) => fn?.name)
    .map((fn) => ({
      name: fn.name as string,
      description: (fn.description ?? "") as string,
      input_schema: fn.input_schema ?? fn.parameters ?? { type: "object", properties: {} },
    }));
}

export interface StopFilter {
  push(text: string): { emit: string; hit: string | null };
  flush(): string;
}

// stop sequences: a wire não suporta, então cortamos aqui (e abortamos o upstream ao cortar).
// `hit` é a sequência que casou (string) ou null — o Anthropic precisa devolvê-la em
// `stop_sequence`; no OpenAI `if (hit)` continua correto (string vazia nunca entra em `stops`).
export function makeStopFilter(stops: string[]): StopFilter {
  const maxLen = stops.reduce((a, s) => Math.max(a, s.length), 0);
  let pending = "";
  return {
    push(text) {
      if (!stops.length) return { emit: text, hit: null };
      pending += text;
      let hitIdx = -1;
      let hitSeq: string | null = null;
      for (const s of stops) {
        const i = pending.indexOf(s);
        if (i !== -1 && (hitIdx === -1 || i < hitIdx)) { hitIdx = i; hitSeq = s; }
      }
      if (hitIdx !== -1) { const emit = pending.slice(0, hitIdx); pending = ""; return { emit, hit: hitSeq }; }
      const keep = Math.max(0, maxLen - 1);
      const emit = pending.slice(0, Math.max(0, pending.length - keep));
      pending = pending.slice(emit.length);
      return { emit, hit: null };
    },
    flush() { const e = pending; pending = ""; return e; },
  };
}

// ---------- erro do upstream -> kind neutro ----------
// Cada dialeto traduz o kind para o seu shape de erro (ver openai.ts / anthropic.ts).
export type ErrorKind = "rate_limit" | "not_found" | "auth" | "permission" | "invalid" | "upstream";

export function classifyUpstreamError(status: number, message: string): { kind: ErrorKind; status: number } {
  const m = String(message || "").toLowerCase();
  if (/rate limit|usage window|too many requests|insufficient credits|credits_exhausted|credits exhausted/.test(m) || status === 429)
    return { kind: "rate_limit", status: 429 };
  if (/model_not_in_plan|not recognized|model not found|unknown model/.test(m))
    return { kind: "not_found", status: 404 };
  if (status === 401 || /invalid .*authorization|unauthorized|invalid api key/.test(m))
    return { kind: "auth", status: 401 };
  if (status === 403) return { kind: "permission", status: 403 };
  if (status >= 400 && status < 500) return { kind: "invalid", status };
  return { kind: "upstream", status: 502 };
}

// ---------- HTTP ----------
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// lê o stream NDJSON do commandcode e entrega cada linha parseada
export async function* readEvents(readable: ReadableStream<Uint8Array>): AsyncGenerator<WireEvent> {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { yield JSON.parse(line) as WireEvent; } catch {}
      }
    }
    // última linha sem \n final (traz o `finish` com usage se o upstream não fechar com newline)
    if (buf.trim()) { try { yield JSON.parse(buf) as WireEvent; } catch {} }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

export function json(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

export function sseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
}

// ---------- wire do commandcode ----------
export interface GenerateParams {
  model: string;
  messages: WireMessage[];
  system: string;
  tools?: WireTool[];
  maxTokens?: number;
  temperature?: unknown;
  topP?: unknown;
  reasoningEffort?: string | null;
}

export function buildGenerateBody({ model, messages, system, tools, maxTokens, temperature, topP, reasoningEffort }: GenerateParams) {
  return {
    config: SERVER_CONFIG,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId: randomUUID(),
    mode: "agent",
    params: {
      model,
      messages,
      tools: tools ?? [],
      system,
      max_tokens: maxTokens ?? MAX_TOKENS,
      stream: true,
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(typeof topP === "number" ? { top_p: topP } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    },
  };
}

export function callUpstream(generateBody: unknown, signal: AbortSignal, sessionId: string = randomUUID()): Promise<Response> {
  return fetch(`${API_BASE}/alpha/generate`, {
    method: "POST",
    headers: authHeaders(sessionId),
    body: JSON.stringify(generateBody),
    signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
  });
}

// extrai a mensagem de erro de uma resposta upstream não-ok
export async function upstreamErrorMessage(resp: Response): Promise<string> {
  try {
    const j = await resp.json() as { error?: { message?: string }; message?: string };
    return j.error?.message ?? j.message ?? `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}
