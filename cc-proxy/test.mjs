#!/usr/bin/env node
// Testes do cc-proxy (dialetos OpenAI e Anthropic).
//   node test.mjs             -> conformidade (mock, sem custo) + SDKs + testes reais (consome crédito)
//   node test.mjs --mock      -> só conformidade + SDKs contra o mock, sem tocar em api.commandcode.ai
//   node test.mjs --openai    -> só o dialeto OpenAI
//   node test.mjs --anthropic -> só o dialeto Anthropic
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_ONLY = process.argv.includes("--mock");
const ONLY_OPENAI = process.argv.includes("--openai");
const ONLY_ANTHROPIC = process.argv.includes("--anthropic");
const RUN_OPENAI = !ONLY_ANTHROPIC;
const RUN_ANTHROPIC = !ONLY_OPENAI;
const rnd = () => 8800 + Math.floor(Math.random() * 900);
const MOCK_PORT = rnd(), PROXY_MOCK_PORT = rnd(), PROXY_PORT = rnd();
const MOCK_BASE = `http://127.0.0.1:${PROXY_MOCK_PORT}`;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const PROXY_IDLE_PORT = rnd(), IDLE_BASE = `http://127.0.0.1:${PROXY_IDLE_PORT}`;
const MODEL = "deepseek/deepseek-v4-flash";

let passed = 0, failed = 0;
function check(name, ok, extra = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---------- mock do upstream: o cenário vem no nome do modelo ----------
const SCENARIOS = {
  "mid-error": [
    { type: "text-delta", text: "parte 1 " },
    { type: "error", error: { message: "usage window limit reached", statusCode: 429, isRetryable: true } },
  ],
  "no-trailing-newline": [
    { type: "text-delta", text: "oi" },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
  ],
  "provider-executed": [
    { type: "tool-call", toolName: "web_search", toolCallId: "srv_1", input: { query: "a" }, providerExecuted: true },
    { type: "tool-result", toolCallId: "srv_1", toolName: "web_search", output: { type: "text", value: "r" } },
    { type: "text-delta", text: "achei" },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
  "reasoning": [
    { type: "reasoning-delta", text: "pensando..." },
    { type: "text-delta", text: "resposta" },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 5, outputTokens: 9, totalTokens: 14, inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 3 }, outputTokenDetails: { reasoningTokens: 7 } } },
  ],
  "max-tokens": [
    { type: "text-delta", text: "corta" },
    { type: "finish", finishReason: "max_tokens", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
  "abort": [{ type: "text-delta", text: "x" }, { type: "abort" }],
  // máquina de estado dos blocos: texto -> tool -> texto (3 blocos, índices 0,1,2)
  "text-tool-text": [
    { type: "text-delta", text: "antes " },
    { type: "tool-call", toolName: "get_weather", toolCallId: "tc_1", input: { city: "Paris" } },
    { type: "text-delta", text: "depois" },
    { type: "finish", finishReason: "tool_calls", totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
  ],
  "tool-only": [
    { type: "tool-call", toolName: "get_weather", toolCallId: "tc_9", input: { city: "Paris" } },
    { type: "finish", finishReason: "tool_calls", totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
  ],
  // reasoning entregue num delta só (grande): o proxy precisa re-chunkar na saída
  "long-reasoning": [
    { type: "reasoning-delta", text: "x".repeat(200) },
    { type: "text-delta", text: "ok" },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 5, outputTokens: 9, totalTokens: 14 } },
  ],
};
let lastUpstreamBody = null;
let upstreamAborted = false;
const mock = createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const body = JSON.parse(b);
  lastUpstreamBody = body;
  const sc = body.params.model;
  if (sc === "http-429") { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "rate limit exceeded" } })); return; }
  if (sc === "http-401") { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Invalid 'Authorization' header" } })); return; }
  if (sc === "not-in-plan") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "model_not_in_plan" } })); return; }
  if (sc === "http-503") { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "overloaded" } })); return; }
  if (sc === "http-529") { res.writeHead(529, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "overloaded" } })); return; }
  if (sc === "slow") {
    // stream que nunca termina: serve pra provar que o cliente desconectando aborta o upstream
    upstreamAborted = false;
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(JSON.stringify({ type: "text-delta", text: "parcial" }) + "\n");
    // 'close' da resposta só dispara quando o proxy derruba a conexão (cliente sumiu)
    res.on("close", () => { if (!res.writableFinished) upstreamAborted = true; });
    return;
  }
  if (sc === "slow-finish") {
    // stream que fica ~3s em silêncio depois do primeiro delta: prova o keepalive ping
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(JSON.stringify({ type: "text-delta", text: "lento" }) + "\n");
    await sleep(3200);
    res.end(JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) + "\n");
    return;
  }
  const evs = SCENARIOS[sc] ?? [{ type: "text-delta", text: "default" }, { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }];
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const txt = evs.map((e) => JSON.stringify(e)).join("\n");
  res.end(sc === "no-trailing-newline" ? txt : txt + "\n");
});

function startProxy(port, extraEnv) {
  const p = spawn(process.execPath, [join(__dirname, "server.ts")], {
    env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${port}] ${d}`));
  p.stderr.on("data", (d) => process.stdout.write(`[${port}-err] ${d}`));
  return p;
}
const procs = [];
function cleanup() { for (const p of procs) { try { p.kill(); } catch {} } try { mock.close(); } catch {} }

async function waitUp(base, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`servidor não subiu: ${base}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(base, body) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { status: r.status, data, text };
}
function sseChunks(text) {
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6))
    .filter((l) => l !== "[DONE]").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------- helpers do dialeto Anthropic ----------
const A_HEADERS = { "Content-Type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" };
async function postA(base, body, path = "/v1/messages") {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: A_HEADERS, body: JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { status: r.status, data, text };
}
async function streamA(base, body, path = "/v1/messages") {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: A_HEADERS, body: JSON.stringify({ ...body, stream: true }) });
  const text = await r.text();
  return { status: r.status, text, events: sseEvents(text) };
}
function sseEvents(text) {
  return text.split("\n\n").map((blk) => blk.trim()).filter(Boolean).map((blk) => {
    const lines = blk.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? null;
    const raw = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? null;
    let data = null; try { data = JSON.parse(raw); } catch {}
    return { event, data };
  }).filter((e) => e.event);
}
const MSG = (extra = {}) => ({ model: "x", max_tokens: 64, messages: [{ role: "user", content: "oi" }], ...extra });

// ---------- conformidade OpenAI (mock, sem custo) ----------
async function conformance() {
  console.log("\n— conformidade OpenAI (mock upstream, sem custo) —");

  // status HTTP mapeado do upstream
  for (const [model, want, code] of [["http-429", 429, "rate_limit_exceeded"], ["http-401", 401, "invalid_api_key"], ["not-in-plan", 404, "model_not_found"]]) {
    const { status, data } = await post(MOCK_BASE, { model, messages: [{ role: "user", content: "x" }] });
    check(`upstream ${model} → HTTP ${want}`, status === want, `status=${status}`);
    check(`  error.code=${code}`, data?.error?.code === code, `code=${data?.error?.code}`);
  }
  {
    const { status, data } = await post(MOCK_BASE, { model: "http-503", messages: [{ role: "user", content: "x" }] });
    check("upstream 503 → overloaded_error", status === 503 && data?.error?.type === "overloaded_error", `status=${status} type=${data?.error?.type}`);
  }

  // esforço de raciocínio (resolveModel compartilhado com o dialeto Anthropic)
  {
    await post(MOCK_BASE, { model: `${MODEL}-low`, messages: [{ role: "user", content: "x" }] });
    check("sufixo de nível fora do catálogo (-low) resolve", lastUpstreamBody?.params?.reasoning_effort === "low" && lastUpstreamBody?.params?.model === MODEL, `model=${lastUpstreamBody?.params?.model} effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    await post(MOCK_BASE, { model: `${MODEL}-max`, reasoning_effort: "low", messages: [{ role: "user", content: "x" }] });
    check("sufixo vence reasoning_effort do body", lastUpstreamBody?.params?.reasoning_effort === "max");
    await post(MOCK_BASE, { model: "moonshotai/Kimi-K3", reasoning_effort: "max", messages: [{ role: "user", content: "x" }] });
    check("modelo sem reasoning descarta o effort", !("reasoning_effort" in (lastUpstreamBody?.params ?? {})));
    await post(MOCK_BASE, { model: MODEL, reasoning_effort: "turbo", messages: [{ role: "user", content: "x" }] });
    check("effort inválido é descartado", !("reasoning_effort" in (lastUpstreamBody?.params ?? {})));
  }

  // erro no meio do stream: evento error, sem [DONE], sem finish_reason falso
  {
    const r = await fetch(`${MOCK_BASE}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mid-error", messages: [{ role: "user", content: "x" }], stream: true }),
    });
    const text = await r.text();
    const chunks = sseChunks(text);
    check("erro mid-stream → chunk error", chunks.some((c) => c.error?.message?.includes("usage window")));
    check("  sem [DONE] após erro", !text.includes("[DONE]"));
    check("  sem finish_reason 'stop' falso", !chunks.some((c) => c.choices?.[0]?.finish_reason === "stop"));
  }
  {
    const { status, data } = await post(MOCK_BASE, { model: "mid-error", messages: [{ role: "user", content: "x" }] });
    check("erro mid-stream não-stream → 429", status === 429, `status=${status}`);
    check("abort do upstream → erro", (await post(MOCK_BASE, { model: "abort", messages: [{ role: "user", content: "x" }] })).status >= 400);
    check("  type mapeado", data?.error?.type === "rate_limit_exceeded");
  }

  // última linha NDJSON sem \n: usage não pode sumir
  {
    const { data } = await post(MOCK_BASE, { model: "no-trailing-newline", messages: [{ role: "user", content: "x" }] });
    check("NDJSON sem newline final → usage preservada", data?.usage?.total_tokens === 12, JSON.stringify(data?.usage));
  }

  // tool executada pelo servidor não vira tool_call do cliente
  {
    const { data } = await post(MOCK_BASE, { model: "provider-executed", messages: [{ role: "user", content: "x" }] });
    check("providerExecuted não vaza como tool_call", !data?.choices?.[0]?.message?.tool_calls, JSON.stringify(data?.choices?.[0]?.message?.tool_calls));
    check("  finish_reason stop", data?.choices?.[0]?.finish_reason === "stop");
  }

  // reasoning + token details
  {
    const { data } = await post(MOCK_BASE, { model: "reasoning", messages: [{ role: "user", content: "x" }] });
    check("reasoning_content exposto", data?.choices?.[0]?.message?.reasoning_content === "pensando...");
    check("  prompt_tokens_details.cached_tokens", data?.usage?.prompt_tokens_details?.cached_tokens === 4);
    check("  completion_tokens_details.reasoning_tokens", data?.usage?.completion_tokens_details?.reasoning_tokens === 7);
  }
  {
    const { data } = await post(MOCK_BASE, { model: "max-tokens", messages: [{ role: "user", content: "x" }] });
    check("finishReason max_tokens → length", data?.choices?.[0]?.finish_reason === "length", `fr=${data?.choices?.[0]?.finish_reason}`);
  }

  // system default (sem ele o upstream injeta ~7.6k tokens de prompt de agente)
  {
    await post(MOCK_BASE, { model: "x", messages: [{ role: "user", content: "oi" }] });
    check("system sempre enviado ao upstream", typeof lastUpstreamBody?.params?.system === "string" && lastUpstreamBody.params.system.length > 0);
    await post(MOCK_BASE, { model: "x", messages: [{ role: "system", content: "SYS-CUSTOM" }, { role: "user", content: "oi" }] });
    check("  system do cliente tem precedência", lastUpstreamBody?.params?.system === "SYS-CUSTOM");
    await post(MOCK_BASE, { model: "x", messages: [{ role: "user", content: "oi" }], response_format: { type: "json_object" } });
    check("  response_format vira instrução de system", /JSON/i.test(lastUpstreamBody?.params?.system ?? ""));
    await post(MOCK_BASE, { model: "x", messages: [{ role: "user", content: "oi" }], tools: [{ type: "function", function: { name: "f", parameters: {} } }], tool_choice: "none" });
    check("  tool_choice none remove tools", Array.isArray(lastUpstreamBody?.params?.tools) && lastUpstreamBody.params.tools.length === 0);
  }

  // config enviada não vaza cwd/git do usuário
  check("config upstream é neutra (sem cwd real)", lastUpstreamBody?.config?.workingDir === "/" && lastUpstreamBody?.config?.structure?.length === 0);

  // validação local antes de gastar quota
  for (const [body, want, param] of [
    [{ model: MODEL, messages: [] }, 400, "messages"],
    [{ model: MODEL }, 400, "messages"],
    [{ model: MODEL, messages: [{ role: "user", content: "a" }], n: 3 }, 400, "n"],
  ]) {
    const { status, data } = await post(MOCK_BASE, body);
    check(`validação local → ${want} (${param})`, status === want && data?.error?.param === param, `status=${status} param=${data?.error?.param}`);
  }

  // rotas
  {
    const r = await fetch(`${MOCK_BASE}/v1/models/${MODEL}`);
    const j = await r.json();
    check("GET /v1/models/{id} → 200", r.status === 200 && j.id === MODEL, `status=${r.status}`);
    check("  created é timestamp real", typeof j.created === "number" && j.created > 1600000000);
    const r2 = await fetch(`${MOCK_BASE}/v1/models/nao-existe`);
    check("GET /v1/models/{id} inexistente → 404 model_not_found", r2.status === 404 && (await r2.json()).error?.code === "model_not_found");
    check("endpoint desconhecido → 404", (await fetch(`${MOCK_BASE}/v1/nope`)).status === 404);
    const r3 = await fetch(`${MOCK_BASE}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" });
    check("body inválido → 400", r3.status === 400);
  }

  // stop sequences (a wire não tem; o corte é do proxy)
  {
    const { data } = await post(MOCK_BASE, { model: "x", messages: [{ role: "user", content: "x" }], stop: ["fau"] });
    check("stop sequence corta o texto", data?.choices?.[0]?.message?.content === "de", `content=${JSON.stringify(data?.choices?.[0]?.message?.content)}`);
  }

  // include_usage: usage:null nos chunks e usage real no último
  {
    const r = await fetch(`${MOCK_BASE}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "x" }], stream: true, stream_options: { include_usage: true } }),
    });
    const chunks = sseChunks(await r.text());
    check("include_usage: usage:null nos chunks de conteúdo", chunks.filter((c) => c.choices?.length).every((c) => "usage" in c && c.usage === null));
    check("  chunk final com usage", chunks.at(-1)?.usage?.total_tokens === 2 && chunks.at(-1)?.choices?.length === 0);
  }

  // roteamento: prefixo /openai força o dialeto mesmo com header Anthropic
  {
    const r = await fetch(`${MOCK_BASE}/openai/v1/models`, { headers: { "x-api-key": "x" } });
    const j = await r.json();
    check("GET /openai/v1/models → shape OpenAI mesmo com x-api-key", j.object === "list" && j.data?.[0]?.object === "model");
    const r2 = await fetch(`${MOCK_BASE}/openai/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "oi" }] }),
    });
    check("POST /openai/v1/chat/completions responde igual", r2.status === 200 && (await r2.json()).object === "chat.completion");
  }

  // cliente desconecta → upstream abortado
  {
    const ac = new AbortController();
    const p = fetch(`${MOCK_BASE}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal,
      body: JSON.stringify({ model: "slow", messages: [{ role: "user", content: "x" }], stream: true }),
    }).then((r) => r.body.getReader().read()).catch(() => null);
    await sleep(400); ac.abort(); await p.catch(() => {}); await sleep(400);
    check("cliente desconecta → upstream abortado", upstreamAborted === true);
  }
}

// ---------- conformidade Anthropic (mock, sem custo) ----------
async function anthropicConformance() {
  console.log("\n— conformidade Anthropic (mock upstream, sem custo) —");

  // --- validação local ---
  {
    const r1 = await postA(MOCK_BASE, { model: "x", messages: [{ role: "user", content: "oi" }] });
    check("max_tokens ausente → 400 invalid_request_error", r1.status === 400 && r1.data?.error?.type === "invalid_request_error" && /max_tokens/.test(r1.data?.error?.message ?? ""), `status=${r1.status}`);
    check("  shape de erro Anthropic", r1.data?.type === "error" && typeof r1.data?.request_id === "string");
    const r2 = await postA(MOCK_BASE, { model: "x", max_tokens: 10, messages: [] });
    check("messages vazio → 400", r2.status === 400 && /messages/.test(r2.data?.error?.message ?? ""), `status=${r2.status}`);
    const r3 = await postA(MOCK_BASE, { max_tokens: 10, messages: [{ role: "user", content: "oi" }] });
    check("model ausente → 400", r3.status === 400 && /model/.test(r3.data?.error?.message ?? ""), `status=${r3.status}`);
    const r4 = await fetch(`${MOCK_BASE}/v1/messages`, { method: "POST", headers: A_HEADERS, body: "not-json" });
    check("body não-JSON → 400", r4.status === 400);
  }

  // --- system ---
  {
    await postA(MOCK_BASE, MSG({ system: "SYS-STR" }));
    check("system string → params.system", lastUpstreamBody?.params?.system === "SYS-STR");
    await postA(MOCK_BASE, MSG({ system: [{ type: "text", text: "A" }, { type: "text", text: "B", cache_control: { type: "ephemeral" } }] }));
    check("system array de blocos → juntado com \\n\\n", lastUpstreamBody?.params?.system === "A\n\nB");
    await postA(MOCK_BASE, MSG());
    check("sem system → DEFAULT_SYSTEM aplicado", lastUpstreamBody?.params?.system === "You are a helpful assistant.", `system=${JSON.stringify(lastUpstreamBody?.params?.system)}`);
    check("config upstream neutra", lastUpstreamBody?.config?.workingDir === "/" && lastUpstreamBody?.config?.structure?.length === 0);
  }

  // --- tools e tool_choice ---
  {
    const tool = { name: "get_weather", description: "clima", input_schema: { type: "object", properties: { city: { type: "string" } } } };
    await postA(MOCK_BASE, MSG({ tools: [tool] }));
    check("tools Anthropic → params.tools sem alteração", JSON.stringify(lastUpstreamBody?.params?.tools) === JSON.stringify([tool]), JSON.stringify(lastUpstreamBody?.params?.tools));
    await postA(MOCK_BASE, MSG({ tools: [tool], tool_choice: { type: "none" } }));
    check("tool_choice none → params.tools []", Array.isArray(lastUpstreamBody?.params?.tools) && lastUpstreamBody.params.tools.length === 0);
    await postA(MOCK_BASE, MSG({ tools: [tool], tool_choice: { type: "tool", name: "get_weather" } }));
    check("tool_choice tool → instrução nomeando a tool no system", /get_weather/.test(lastUpstreamBody?.params?.system ?? ""));
    await postA(MOCK_BASE, MSG({ tools: [tool], tool_choice: { type: "any" } }));
    check("tool_choice any → instrução no system", /pelo menos uma das ferramentas/i.test(lastUpstreamBody?.params?.system ?? ""));
    await postA(MOCK_BASE, MSG({ tools: [{ name: "sem_schema" }] }));
    check("tool sem input_schema → default {type:object}", lastUpstreamBody?.params?.tools?.[0]?.input_schema?.type === "object");
  }

  // --- blocos de conteúdo ---
  {
    await postA(MOCK_BASE, MSG({
      messages: [
        { role: "user", content: "clima?" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "text", text: "vou ver" }, { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "18C" }, { type: "text", text: "e amanhã?" }] },
      ],
    }));
    const m = lastUpstreamBody?.params?.messages ?? [];
    check("tool_result vira mensagem wire role:tool", m[2]?.role === "tool" && m[2]?.content?.[0]?.type === "tool-result", JSON.stringify(m[2]));
    check("  toolCallId/toolName resolvidos", m[2]?.content?.[0]?.toolCallId === "tu_1" && m[2]?.content?.[0]?.toolName === "get_weather");
    check("  tool antes de user (mensagem mista vira 2)", m[3]?.role === "user" && m[3]?.content?.[0]?.text === "e amanhã?", JSON.stringify(m[3]));
    check("  assistant: thinking preservado como reasoning", m[1]?.role === "assistant" && m[1].content.length === 3 && m[1].content[0].type === "reasoning" && m[1].content[0].text === "hmm" && m[1].content[1].type === "text" && m[1].content[2].type === "tool-call");
    check("  tool_use → tool-call com input objeto", typeof m[1]?.content?.[2]?.input === "object" && m[1].content[2].input.city === "Paris");
  }
  {
    // EnsureThinkingBlocks: tool turn sem thinking ganha reasoning placeholder (round-trip de tool)
    await postA(MOCK_BASE, MSG({ messages: [
      { role: "user", content: "clima?" },
      { role: "assistant", content: [{ type: "text", text: "vou ver" }, { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "18C" }] },
    ] }));
    const asst = (lastUpstreamBody?.params?.messages ?? []).find((x) => x.role === "assistant");
    check("tool turn sem thinking → reasoning injetado", asst?.content?.some((p) => p.type === "reasoning"), JSON.stringify(asst?.content));
  }
  {
    await postA(MOCK_BASE, MSG({ messages: [
      { role: "user", content: "clima?" },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "abc" }, { type: "tool_use", id: "tu_1", name: "get_weather", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "18C" }] },
    ] }));
    const asst = (lastUpstreamBody?.params?.messages ?? []).find((x) => x.role === "assistant");
    const r = asst?.content?.find((p) => p.type === "reasoning");
    check("redacted_thinking → reasoning placeholder", r?.text === " ", JSON.stringify(asst?.content));
  }
  {
    await postA(MOCK_BASE, MSG({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "zz", content: [{ type: "text", text: "boom" }], is_error: true }] }] }));
    const tr = lastUpstreamBody?.params?.messages?.[0]?.content?.[0];
    check("tool_result is_error → value prefixado com 'Error: '", tr?.output?.value === "Error: boom", JSON.stringify(tr));
    check("  tool_use_id sem match → toolName unknown", tr?.toolName === "unknown");
  }
  {
    await postA(MOCK_BASE, MSG({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "o que é?" }] }] }));
    const c = lastUpstreamBody?.params?.messages?.[0]?.content ?? [];
    check("imagem base64 → {type:image,image:data:...,mimeType}", c[0]?.type === "image" && c[0]?.image === "data:image/png;base64,AAAA" && c[0]?.mimeType === "image/png", JSON.stringify(c[0]));
    const r = await postA(MOCK_BASE, MSG({ messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } }] }] }));
    check("bloco document → 400 invalid_request_error", r.status === 400 && r.data?.error?.type === "invalid_request_error", `status=${r.status}`);
  }

  // --- parâmetros ---
  {
    await postA(MOCK_BASE, MSG({ output_config: { effort: "high" }, temperature: 0.3, top_p: 0.9, top_k: 40, metadata: { user_id: "u" } }));
    check("output_config.effort → params.reasoning_effort", lastUpstreamBody?.params?.reasoning_effort === "high");
    check("  temperature/top_p repassados, top_k ignorado", lastUpstreamBody?.params?.temperature === 0.3 && lastUpstreamBody?.params?.top_p === 0.9 && !("top_k" in lastUpstreamBody.params));
    check("  max_tokens repassado", lastUpstreamBody?.params?.max_tokens === 64);
    await postA(MOCK_BASE, MSG({ model: `${MODEL}-max`, output_config: { effort: "low" } }));
    check("sufixo -max vence output_config.effort", lastUpstreamBody?.params?.reasoning_effort === "max" && lastUpstreamBody?.params?.model === MODEL, `effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    await postA(MOCK_BASE, MSG({ output_config: { effort: "high" }, thinking: { type: "disabled" } }));
    check("thinking disabled → sem reasoning_effort", !("reasoning_effort" in (lastUpstreamBody?.params ?? {})));
    await postA(MOCK_BASE, MSG({ model: `${MODEL}-low` }));
    check("sufixo de nível fora do catálogo (-low) resolve", lastUpstreamBody?.params?.reasoning_effort === "low" && lastUpstreamBody?.params?.model === MODEL, `model=${lastUpstreamBody?.params?.model} effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    for (const [budget, want] of [[1024, "low"], [4096, "medium"], [16000, "high"], [60000, "max"]]) {
      await postA(MOCK_BASE, MSG({ thinking: { type: "enabled", budget_tokens: budget } }));
      check(`  budget_tokens ${budget} → effort ${want}`, lastUpstreamBody?.params?.reasoning_effort === want, `effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    }
    await postA(MOCK_BASE, MSG({ output_config: { effort: "max" }, thinking: { type: "enabled", budget_tokens: 1024 } }));
    check("output_config.effort vence budget_tokens", lastUpstreamBody?.params?.reasoning_effort === "max", `effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    await postA(MOCK_BASE, MSG({ model: "moonshotai/Kimi-K3", output_config: { effort: "max" } }));
    check("modelo sem reasoning descarta o effort", !("reasoning_effort" in (lastUpstreamBody?.params ?? {})), `effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    // grafias alternativas de effort (razing.effort / effort / level / depth)
    for (const [extra, want] of [
      [{ reasoning: { effort: "medium" } }, "medium"],
      [{ effort: "high" }, "high"],
      [{ level: "low" }, "low"],
      [{ depth: 1 }, "low"],
      [{ depth: 2 }, "medium"],
      [{ depth: 3 }, "high"],
      [{ depth: 5 }, "max"],
    ]) {
      await postA(MOCK_BASE, MSG(extra));
      check(`  grafia ${JSON.stringify(extra)} → effort ${want}`, lastUpstreamBody?.params?.reasoning_effort === want, `effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    }
    await postA(MOCK_BASE, MSG({ output_config: { effort: "high" }, reasoning: { effort: "low" } }));
    check("  output_config.effort vence reasoning.effort", lastUpstreamBody?.params?.reasoning_effort === "high");
    await postA(MOCK_BASE, MSG({ depth: "x" }));
    check("  depth inválido → sem effort", !("reasoning_effort" in (lastUpstreamBody?.params ?? {})), `effort=${lastUpstreamBody?.params?.reasoning_effort}`);
    await postA(MOCK_BASE, MSG({ stop_sequences: ["FIM"] }));
    check("stop_sequences não vai pra wire", !("stop_sequences" in (lastUpstreamBody?.params ?? {})) && !("stop" in (lastUpstreamBody?.params ?? {})));
  }

  // --- resposta não-stream ---
  {
    const { status, data } = await postA(MOCK_BASE, MSG());
    check("POST /v1/messages → 200", status === 200, `status=${status}`);
    check("  id com prefixo msg_", typeof data?.id === "string" && data.id.startsWith("msg_"), `id=${data?.id}`);
    check("  type/role/model", data?.type === "message" && data?.role === "assistant" && typeof data?.model === "string");
    check("  content[0] text", Array.isArray(data?.content) && data.content[0]?.type === "text" && data.content[0].text === "default");
    check("  stop_reason end_turn + stop_sequence null", data?.stop_reason === "end_turn" && data?.stop_sequence === null);
    check("  usage shape", data?.usage?.input_tokens === 1 && data?.usage?.output_tokens === 1 && "cache_creation_input_tokens" in data.usage && "cache_read_input_tokens" in data.usage);
  }
  {
    const { data } = await postA(MOCK_BASE, MSG({ model: "tool-only" }));
    const tu = data?.content?.find((b) => b.type === "tool_use");
    check("tool call → bloco tool_use", !!tu && tu.name === "get_weather" && tu.id === "tc_9", JSON.stringify(data?.content));
    check("  input é objeto (não string)", tu && typeof tu.input === "object" && tu.input.city === "Paris");
    check("  stop_reason tool_use", data?.stop_reason === "tool_use", `sr=${data?.stop_reason}`);
  }
  {
    const { data } = await postA(MOCK_BASE, MSG({ model: "provider-executed" }));
    check("providerExecuted não vira tool_use", !data?.content?.some((b) => b.type === "tool_use"), JSON.stringify(data?.content));
    const { data: d2 } = await postA(MOCK_BASE, MSG({ model: "no-trailing-newline" }));
    check("NDJSON sem newline final → usage preservada", d2?.usage?.input_tokens === 10, JSON.stringify(d2?.usage));
    const { data: d3 } = await postA(MOCK_BASE, MSG({ model: "max-tokens" }));
    check("finishReason max_tokens → stop_reason max_tokens", d3?.stop_reason === "max_tokens", `sr=${d3?.stop_reason}`);
  }
  {
    const { data: sem } = await postA(MOCK_BASE, MSG({ model: "reasoning" }));
    check("reasoning sem thinking no request → sem bloco thinking", !sem?.content?.some((b) => b.type === "thinking"), JSON.stringify(sem?.content));
    const { data: com } = await postA(MOCK_BASE, MSG({ model: "reasoning", thinking: { type: "adaptive" } }));
    const th = com?.content?.find((b) => b.type === "thinking");
    check("  com thinking:{adaptive} → bloco thinking", !!th && th.thinking === "pensando..." && th.signature === "", JSON.stringify(com?.content));
    check("  cache tokens do usage", com?.usage?.cache_read_input_tokens === 4 && com?.usage?.cache_creation_input_tokens === 3, JSON.stringify(com?.usage));
  }
  {
    const { data } = await postA(MOCK_BASE, MSG({ stop_sequences: ["fau"] }));
    check("stop_sequences corta o texto", data?.content?.[0]?.text === "de", JSON.stringify(data?.content));
    check("  stop_reason stop_sequence + stop_sequence preenchido", data?.stop_reason === "stop_sequence" && data?.stop_sequence === "fau", `sr=${data?.stop_reason} ss=${data?.stop_sequence}`);
  }

  // --- stream SSE ---
  {
    const { events, text } = await streamA(MOCK_BASE, MSG());
    check("stream: primeiro evento message_start", events[0]?.event === "message_start" && events[0]?.data?.message?.type === "message" && Array.isArray(events[0]?.data?.message?.content) && events[0].data.message.content.length === 0);
    const names = events.map((e) => e.event);
    check("  ordem block_start → delta → block_stop → message_delta → message_stop",
      names.indexOf("content_block_start") < names.indexOf("content_block_delta") &&
      names.indexOf("content_block_delta") < names.indexOf("content_block_stop") &&
      names.indexOf("content_block_stop") < names.indexOf("message_delta") &&
      names.at(-1) === "message_stop", names.join(","));
    check("  sem [DONE]", !text.includes("[DONE]"));
    check("  SSE usa event: e data:", /event: message_start\ndata: \{/.test(text));
    const md = events.find((e) => e.event === "message_delta");
    check("  message_delta com stop_reason e usage", md?.data?.delta?.stop_reason === "end_turn" && md?.data?.usage?.output_tokens > 0, JSON.stringify(md?.data));
  }
  {
    const { events } = await streamA(MOCK_BASE, MSG({ model: "text-tool-text" }));
    const blocks = events.filter((e) => e.event === "content_block_start");
    check("stream texto→tool→texto: 3 blocos com índices 0,1,2", blocks.length === 3 && blocks.map((b) => b.data.index).join(",") === "0,1,2", blocks.map((b) => `${b.data.index}:${b.data.content_block.type}`).join(","));
    check("  tipos text,tool_use,text", blocks.map((b) => b.data.content_block.type).join(",") === "text,tool_use,text");
    // cada start é precedido do stop do anterior
    const seq = events.filter((e) => ["content_block_start", "content_block_stop"].includes(e.event)).map((e) => `${e.event === "content_block_start" ? "S" : "E"}${e.data.index}`).join(" ");
    check("  fecha antes de abrir o próximo", seq === "S0 E0 S1 E1 S2 E2", seq);
    const tuStart = blocks[1].data.content_block;
    check("  tool_use start traz id/name e input {}", tuStart.id === "tc_1" && tuStart.name === "get_weather" && JSON.stringify(tuStart.input) === "{}");
    const tuDelta = events.find((e) => e.event === "content_block_delta" && e.data.index === 1);
    check("  delta input_json_delta parseável", tuDelta?.data?.delta?.type === "input_json_delta" && JSON.parse(tuDelta.data.delta.partial_json).city === "Paris");
    const md = events.find((e) => e.event === "message_delta");
    check("  stop_reason tool_use", md?.data?.delta?.stop_reason === "tool_use", JSON.stringify(md?.data?.delta));
  }
  {
    const { events } = await streamA(MOCK_BASE, MSG({ model: "reasoning", thinking: { type: "adaptive" } }));
    const first = events.find((e) => e.event === "content_block_start");
    check("stream thinking: primeiro bloco é thinking", first?.data?.content_block?.type === "thinking", JSON.stringify(first?.data));
    check("  thinking_delta emitido", events.some((e) => e.data?.delta?.type === "thinking_delta"));
    check("  signature_delta antes do stop", events.some((e) => e.data?.delta?.type === "signature_delta"));
  }
  {
    // reasoning entregue num delta só e grande: re-chunk em vários thinking_delta com pacing
    const { events } = await streamA(MOCK_BASE, MSG({ model: "long-reasoning", thinking: { type: "adaptive" } }));
    const deltas = events.filter((e) => e.data?.delta?.type === "thinking_delta");
    check("re-chunk: reasoning grande vira vários thinking_delta", deltas.length >= 4, `n=${deltas.length}`);
    check("  texto íntegro entre deltas", deltas.map((e) => e.data.delta.thinking).join("") === "x".repeat(200), `len=${deltas.map((e) => e.data.delta.thinking).join("").length}`);
  }
  {
    // upstream em silêncio >3s entre deltas: keepalive ping mantém o stream vivo
    const { events } = await streamA(MOCK_BASE, MSG({ model: "slow-finish" }));
    check("stream idle → keepalive ping", events.some((e) => e.event === "ping" && e.data?.type === "ping"), events.map((e) => e.event).join(","));
  }
  {
    const { events, text } = await streamA(MOCK_BASE, MSG({ model: "mid-error" }));
    const errIdx = events.findIndex((e) => e.event === "error");
    check("erro mid-stream → evento error", errIdx !== -1 && events[errIdx].data?.error?.type === "rate_limit_error", text.slice(0, 200));
    check("  sem message_stop depois do erro", !events.slice(errIdx + 1).some((e) => e.event === "message_stop"));
  }
  {
    const { events } = await streamA(MOCK_BASE, MSG({ stop_sequences: ["fau"] }));
    const md = events.find((e) => e.event === "message_delta");
    check("stream stop sequence → stop_reason/stop_sequence", md?.data?.delta?.stop_reason === "stop_sequence" && md?.data?.delta?.stop_sequence === "fau", JSON.stringify(md?.data?.delta));
    check("  message_stop presente", events.at(-1)?.event === "message_stop");
  }

  // --- erros do upstream ---
  {
    for (const [model, want, type] of [["http-429", 429, "rate_limit_error"], ["http-401", 401, "authentication_error"], ["not-in-plan", 404, "not_found_error"]]) {
      const { status, data } = await postA(MOCK_BASE, MSG({ model }));
      check(`upstream ${model} → HTTP ${want} ${type}`, status === want && data?.error?.type === type, `status=${status} type=${data?.error?.type}`);
    }
    for (const [model, want] of [["http-503", 503], ["http-529", 529]]) {
      const { status, data } = await postA(MOCK_BASE, MSG({ model }));
      check(`upstream ${model} → overloaded_error`, status === want && data?.error?.type === "overloaded_error", `status=${status} type=${data?.error?.type}`);
    }
  }
  {
    const r = await fetch(`${MOCK_BASE}/v1/messages`, { method: "POST", headers: A_HEADERS, body: JSON.stringify(MSG({ model: "http-429" })) });
    check("429 → header Retry-After: 30", r.headers.get("retry-after") === "30", `ra=${r.headers.get("retry-after")}`);
  }

  // --- rotas / desambiguação de /v1/models ---
  {
    const r = await fetch(`${MOCK_BASE}/v1/models`, { headers: { "x-api-key": "k" } });
    const j = await r.json();
    check("GET /v1/models com x-api-key → shape Anthropic", j.has_more === false && j.data?.[0]?.type === "model" && typeof j.data?.[0]?.display_name === "string");
    check("  created_at ISO 8601", !Number.isNaN(Date.parse(j.data?.[0]?.created_at ?? "")));
    const r2 = await fetch(`${MOCK_BASE}/v1/models`);
    const j2 = await r2.json();
    check("GET /v1/models sem header → shape OpenAI", j2.object === "list" && j2.data?.[0]?.object === "model");
    const r3 = await fetch(`${MOCK_BASE}/anthropic/v1/models`);
    check("GET /anthropic/v1/models → shape Anthropic sem header", (await r3.json()).data?.[0]?.type === "model");
    const r4 = await fetch(`${MOCK_BASE}/anthropic/v1/models/${MODEL}`, { headers: { "x-api-key": "k" } });
    const j4 = await r4.json();
    check("GET /v1/models/{id} → shape Anthropic", r4.status === 200 && j4.id === MODEL && j4.type === "model");
    const r5 = await fetch(`${MOCK_BASE}/anthropic/v1/models/nao-existe`);
    check("GET /v1/models/{id} inexistente → 404 not_found_error", r5.status === 404 && (await r5.json()).error?.type === "not_found_error");
    const r6 = await fetch(`${MOCK_BASE}/anthropic/v1/nope`, { method: "POST", headers: A_HEADERS, body: "{}" });
    check("rota desconhecida no dialeto Anthropic → 404 not_found_error", r6.status === 404 && (await r6.json()).error?.type === "not_found_error");
  }

  // --- count_tokens ---
  {
    const r = await postA(MOCK_BASE, { model: "x", messages: [{ role: "user", content: "conte estes tokens por favor" }] }, "/v1/messages/count_tokens");
    check("POST /v1/messages/count_tokens → {input_tokens}", r.status === 200 && typeof r.data?.input_tokens === "number" && r.data.input_tokens > 0 && Object.keys(r.data).length === 1, JSON.stringify(r.data));
    const r2 = await postA(MOCK_BASE, { model: "x" }, "/v1/messages/count_tokens");
    check("  sem messages → 400", r2.status === 400);
    // base64 de ~1.5MB em imagem: o char/4 antigo estouraria (~350k tokens); estimativa clampa ~4000
    const bigB64 = "A".repeat(2 * 1024 * 1024);
    const r3 = await postA(MOCK_BASE, { model: "x", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bigB64 } }, { type: "text", text: "o que é?" }] }] }, "/v1/messages/count_tokens");
    check("  imagem não estoura a conta", r3.status === 200 && r3.data.input_tokens > 0 && r3.data.input_tokens < 10000, `input_tokens=${r3.data?.input_tokens}`);
  }

  // --- prefixo /anthropic e cancelamento ---
  {
    const r = await postA(MOCK_BASE, MSG(), "/anthropic/v1/messages");
    check("POST /anthropic/v1/messages responde igual", r.status === 200 && r.data?.type === "message", `status=${r.status}`);
    const ac = new AbortController();
    const p = fetch(`${MOCK_BASE}/v1/messages`, {
      method: "POST", headers: A_HEADERS, signal: ac.signal,
      body: JSON.stringify(MSG({ model: "slow", stream: true })),
    }).then((r2) => r2.body.getReader().read()).catch(() => null);
    await sleep(400); ac.abort(); await p.catch(() => {}); await sleep(400);
    check("cliente desconecta → upstream abortado", upstreamAborted === true);
  }

  // --- idle watchdog (proxy dedicado com timeout curto) ---
  {
    procs.push(startProxy(PROXY_IDLE_PORT, { COMMANDCODE_API_URL: `http://127.0.0.1:${MOCK_PORT}`, COMMAND_CODE_API_KEY: "fake-key", CC_IDLE_TIMEOUT_MS: "500" }));
    await waitUp(IDLE_BASE);
    const r = await fetch(`${IDLE_BASE}/v1/messages`, { method: "POST", headers: A_HEADERS, body: JSON.stringify(MSG({ model: "slow", stream: true })) });
    const text = await r.text();
    const evs = sseEvents(text);
    check("idle watchdog: stream pendurado → evento error", evs.some((e) => e.event === "error"), evs.map((e) => e.event).join(","));
  }
}

// ---------- validação com os SDKs oficiais (contra o mock) ----------
async function sdkMock() {
  console.log("\n— SDKs oficiais contra o mock —");

  if (RUN_OPENAI) {
    let OpenAI;
    try { ({ default: OpenAI } = await import("openai")); } catch { console.log("  (SDK openai não instalado — pulando)"); OpenAI = null; }
    if (OpenAI) {
      const c = new OpenAI({ baseURL: `${MOCK_BASE}/openai/v1`, apiKey: "x", maxRetries: 0 });
      const m = await c.chat.completions.create({ model: "x", messages: [{ role: "user", content: "oi" }] });
      check("SDK openai: create", m.choices[0].message.content === "default");
      const s = await c.chat.completions.create({ model: "x", messages: [{ role: "user", content: "oi" }], stream: true });
      let acc = ""; for await (const ch of s) acc += ch.choices[0]?.delta?.content ?? "";
      check("  stream", acc === "default", acc);
      let threw = null;
      try { await c.chat.completions.create({ model: "http-429", messages: [{ role: "user", content: "x" }] }); } catch (e) { threw = e; }
      check("  erro tipado RateLimitError", threw?.status === 429 && threw?.constructor?.name === "RateLimitError", threw?.constructor?.name);
    }
  }

  if (RUN_ANTHROPIC) {
    let Anthropic;
    try { ({ default: Anthropic } = await import("@anthropic-ai/sdk")); } catch { console.log("  (SDK @anthropic-ai/sdk não instalado — pulando)"); Anthropic = null; }
    if (Anthropic) {
      const c = new Anthropic({ baseURL: `${MOCK_BASE}/anthropic`, apiKey: "x", maxRetries: 0 });
      const m = await c.messages.create({ model: "x", max_tokens: 64, messages: [{ role: "user", content: "oi" }] });
      check("SDK anthropic: create", m.content[0]?.type === "text" && m.content[0].text === "default" && m.stop_reason === "end_turn");

      const s = c.messages.stream({ model: "text-tool-text", max_tokens: 64, messages: [{ role: "user", content: "oi" }] });
      let evs = 0; for await (const _ of s) evs++;
      const final = await s.finalMessage();
      check("  stream + finalMessage monta os blocos", evs > 0 && final.content.length === 3 && final.content[1].type === "tool_use", JSON.stringify(final.content.map((b) => b.type)));
      check("  tool_use.input é objeto", final.content[1].type === "tool_use" && final.content[1].input?.city === "Paris", JSON.stringify(final.content[1]));
      check("  finalMessage.usage.input_tokens real", final.usage?.input_tokens === 3, JSON.stringify(final.usage));
      check("  stop_reason tool_use", final.stop_reason === "tool_use");

      // round-trip de tool: manda o content de volta + tool_result
      const tu = final.content.find((b) => b.type === "tool_use");
      const r2 = await c.messages.create({
        model: "x", max_tokens: 64,
        messages: [
          { role: "user", content: "clima?" },
          { role: "assistant", content: final.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "18C" }] },
        ],
      });
      check("  round-trip de tool aceito", r2.content[0]?.type === "text");
      const wm = lastUpstreamBody?.params?.messages ?? [];
      check("  wire do round-trip: user, assistant, tool", wm.map((x) => x.role).join(",") === "user,assistant,tool", wm.map((x) => x.role).join(","));

      let threw = null;
      try { await c.messages.create({ model: "http-429", max_tokens: 16, messages: [{ role: "user", content: "x" }] }); } catch (e) { threw = e; }
      check("  erro tipado RateLimitError", threw?.status === 429 && threw?.constructor?.name === "RateLimitError", threw?.constructor?.name);
      threw = null;
      try { await c.messages.create({ model: "not-in-plan", max_tokens: 16, messages: [{ role: "user", content: "x" }] }); } catch (e) { threw = e; }
      check("  erro tipado NotFoundError", threw?.status === 404 && threw?.constructor?.name === "NotFoundError", threw?.constructor?.name);
      threw = null;
      try {
        const st = c.messages.stream({ model: "mid-error", max_tokens: 16, messages: [{ role: "user", content: "x" }] });
        for await (const _ of st) {}
        await st.finalMessage();
      } catch (e) { threw = e; }
      check("  erro mid-stream lança no SDK", !!threw, String(threw));
      const ct = await c.messages.countTokens({ model: "x", messages: [{ role: "user", content: "quantos tokens?" }] });
      check("  countTokens", ct.input_tokens > 0, JSON.stringify(ct));
      const list = await c.models.list();
      check("  models.list", Array.isArray(list.data) && list.data[0]?.type === "model");
    }
  }
}

// ---------- testes reais OpenAI (consomem crédito) ----------
async function real() {
  console.log("\n— testes reais OpenAI contra api.commandcode.ai (consome crédito) —");

  {
    const r = await fetch(`${BASE}/v1/models`);
    const j = await r.json();
    check("GET /v1/models → 200 list", r.status === 200 && j.object === "list" && Array.isArray(j.data), `status=${r.status}`);
    check("  inclui modelo default", j.data.some((m) => m.id === MODEL));
    check("  inclui variante -max", j.data.some((m) => m.id === `${MODEL}-max`));
  }

  {
    const { status, data } = await post(BASE, { model: MODEL, messages: [{ role: "user", content: "Reply with the single word: PONG" }] });
    check("chat não-stream → 200", status === 200, `status=${status}`);
    check("  shape chat.completion", data?.object === "chat.completion" && data?.choices?.length === 1);
    check("  content resposta", typeof data?.choices?.[0]?.message?.content === "string" && data.choices[0].message.content.length > 0);
    check("  finish_reason stop", data?.choices?.[0]?.finish_reason === "stop", `fr=${data?.choices?.[0]?.finish_reason}`);
    check("  usage shape", typeof data?.usage?.prompt_tokens === "number" && typeof data?.usage?.total_tokens === "number");
    // sem system default o upstream injeta ~7.6k tokens de prompt de agente
    check("  prompt_tokens sem prompt de agente (<1000)", data?.usage?.prompt_tokens < 1000, `prompt_tokens=${data?.usage?.prompt_tokens}`);
    console.log(`    → "${data?.choices?.[0]?.message?.content?.slice(0, 80)}" (${data?.usage?.prompt_tokens} tok in)`);
  }

  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Count 1 2 3." }], stream: true, stream_options: { include_usage: true } }),
    });
    const text = await r.text();
    const chunks = sseChunks(text);
    const last = [...chunks].reverse().find((c) => c.choices?.length);
    check("chat stream → SSE", r.status === 200 && text.includes("[DONE]"), `status=${r.status}`);
    check("  delta content", chunks.some((c) => c.choices?.[0]?.delta?.content));
    check("  primeiro chunk com role", chunks[0]?.choices?.[0]?.delta?.role === "assistant");
    check("  finish_reason final", last?.choices?.[0]?.finish_reason === "stop", `fr=${last?.choices?.[0]?.finish_reason}`);
    check("  include_usage", chunks.some((c) => c.usage?.total_tokens > 0));
  }

  {
    const tool = {
      type: "function",
      function: { name: "get_weather", description: "Returns weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
    };
    const { status, data } = await post(BASE, {
      model: MODEL, tools: [tool],
      messages: [{ role: "user", content: "Use the get_weather tool to check the weather in Paris. Call it right away — do not ask." }],
    });
    check("tool call → 200", status === 200, `status=${status}`);
    const tcs = data?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(tcs) && tcs.length) {
      check("  message.tool_calls shape", tcs.every((tc) => tc.type === "function" && tc.function?.name === "get_weather" && typeof tc.function.arguments === "string"));
      check("  finish_reason tool_calls", data.choices[0].finish_reason === "tool_calls", `fr=${data.choices[0].finish_reason}`);
      console.log(`    → tool_call: get_weather(${tcs[0].function.arguments})`);
      const args = JSON.parse(tcs[0].function.arguments);
      const r2 = await post(BASE, {
        model: MODEL, tools: [tool],
        messages: [
          { role: "user", content: "Use the get_weather tool for Paris." },
          { role: "assistant", content: null, tool_calls: [{ id: tcs[0].id, type: "function", function: { name: "get_weather", arguments: tcs[0].function.arguments } }] },
          { role: "tool", tool_call_id: tcs[0].id, content: `Weather in ${args.city}: 18°C sunny` },
        ],
      });
      check("multi-turn com tool → 200", r2.status === 200, `status=${r2.status}`);
      check("  responde após tool", (r2.data?.choices?.[0]?.message?.content ?? "").length > 0);
    } else {
      check("  message.tool_calls (modelo não chamou tool — shape ok)", data?.choices?.[0]?.message !== undefined);
    }
  }

  {
    const { status, data } = await post(BASE, { model: `${MODEL}-max`, messages: [{ role: "user", content: "Reply with exactly: OK" }] });
    check("variante -max → 200", status === 200, `status=${status}`);
    check("  model ecoa id base", data?.model === MODEL, `model=${data?.model}`);
  }

  {
    const { status, data } = await post(BASE, {
      model: MODEL, messages: [{ role: "system", content: "Always answer in Portuguese." }, { role: "user", content: "Say hello." }],
    });
    check("system message → 200", status === 200, `status=${status}`);
    check("  respeita system", /olá|oi|hello/i.test(data?.choices?.[0]?.message?.content ?? ""));
  }

  {
    const { data } = await post(BASE, {
      model: MODEL, response_format: { type: "json_object" },
      messages: [{ role: "user", content: "Liste 2 cores na chave 'cores'." }],
    });
    let ok = false; try { ok = !!JSON.parse(data?.choices?.[0]?.message?.content ?? ""); } catch {}
    check("response_format json_object → JSON parseável", ok, JSON.stringify(data?.choices?.[0]?.message?.content?.slice(0, 60)));
  }

  {
    const { data } = await post(BASE, { model: MODEL, stop: ["FIM"], messages: [{ role: "user", content: "Escreva exatamente: um dois FIM tres quatro" }] });
    const c = data?.choices?.[0]?.message?.content ?? "";
    check("stop sequence real → corta antes de FIM", !c.includes("FIM") && c.length > 0, JSON.stringify(c));
  }

  {
    const { status, data } = await post(BASE, { model: "modelo/inexistente-xyz", messages: [{ role: "user", content: "oi" }] });
    check("modelo inexistente → 404 model_not_found", status === 404 && data?.error?.code === "model_not_found", `status=${status} code=${data?.error?.code}`);
  }
}

// ---------- testes reais Anthropic (consomem crédito) ----------
async function anthropicReal() {
  console.log("\n— testes reais Anthropic contra api.commandcode.ai (consome crédito) —");

  {
    const { status, data } = await postA(BASE, { model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "Reply with the single word: PONG" }] });
    check("messages não-stream → 200", status === 200, `status=${status} ${JSON.stringify(data)?.slice(0, 160)}`);
    check("  content[0].text não vazio", data?.content?.[0]?.type === "text" && data.content[0].text.length > 0);
    check("  stop_reason end_turn", data?.stop_reason === "end_turn", `sr=${data?.stop_reason}`);
    // sem system default o upstream injeta ~7.6k tokens de prompt de agente
    check("  input_tokens < 1000 (system default aplicado)", data?.usage?.input_tokens > 0 && data.usage.input_tokens < 1000, `input_tokens=${data?.usage?.input_tokens}`);
    console.log(`    → "${data?.content?.[0]?.text?.slice(0, 80)}" (${data?.usage?.input_tokens} tok in)`);
  }

  {
    const { status, events } = await streamA(BASE, { model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "Conte 1 2 3." }] });
    const txt = events.filter((e) => e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
    check("messages stream → 200", status === 200, `status=${status}`);
    check("  texto acumulado não vazio", txt.length > 0, txt.slice(0, 60));
    check("  message_stop recebido", events.at(-1)?.event === "message_stop", events.at(-1)?.event);
  }

  {
    const tool = { name: "get_weather", description: "Returns weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
    const { status, data } = await postA(BASE, {
      model: MODEL, max_tokens: 512, tools: [tool],
      messages: [{ role: "user", content: "Use the get_weather tool to check the weather in Paris. Call it right away — do not ask." }],
    });
    check("tool use → 200", status === 200, `status=${status}`);
    const tu = data?.content?.find((b) => b.type === "tool_use");
    if (tu) {
      check("  bloco tool_use com input objeto", typeof tu.input === "object" && typeof tu.id === "string", JSON.stringify(tu));
      check("  stop_reason tool_use", data.stop_reason === "tool_use", `sr=${data.stop_reason}`);
      console.log(`    → tool_use: ${tu.name}(${JSON.stringify(tu.input)})`);
      const r2 = await postA(BASE, {
        model: MODEL, max_tokens: 512, tools: [tool],
        messages: [
          { role: "user", content: "Use the get_weather tool for Paris." },
          { role: "assistant", content: data.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "18°C, ensolarado" }] },
        ],
      });
      check("  round-trip com tool_result → 200", r2.status === 200, `status=${r2.status}`);
      check("  resposta final coerente", (r2.data?.content?.find((b) => b.type === "text")?.text ?? "").length > 0);
    } else {
      check("  modelo não chamou tool (shape ok)", Array.isArray(data?.content));
    }
  }

  {
    const { data } = await postA(BASE, { model: MODEL, max_tokens: 1024, system: "Responda sempre em português.", messages: [{ role: "user", content: "Say hello." }] });
    check("system respeitado (português)", /olá|oi|bom dia|ol/i.test(data?.content?.[0]?.text ?? ""), JSON.stringify(data?.content?.[0]?.text?.slice(0, 60)));
  }

  {
    const { data } = await postA(BASE, { model: MODEL, max_tokens: 1024, stop_sequences: ["FIM"], messages: [{ role: "user", content: "Escreva exatamente: um dois FIM tres quatro" }] });
    const t = data?.content?.[0]?.text ?? "";
    check("stop_sequences real → corta antes de FIM", !t.includes("FIM") && t.length > 0, JSON.stringify(t));
    check("  stop_reason stop_sequence", data?.stop_reason === "stop_sequence", `sr=${data?.stop_reason}`);
  }

  {
    const { status, data } = await postA(BASE, { model: "modelo/inexistente-xyz", max_tokens: 32, messages: [{ role: "user", content: "oi" }] });
    check("modelo inexistente → 404 not_found_error", status === 404 && data?.error?.type === "not_found_error", `status=${status} type=${data?.error?.type}`);
  }

  {
    const { status, data } = await postA(BASE, { model: `${MODEL}-max`, max_tokens: 1024, messages: [{ role: "user", content: "Reply with exactly: OK" }] });
    check("variante -max → 200", status === 200, `status=${status}`);
    check("  model ecoa id base", data?.model === MODEL, `model=${data?.model}`);
  }

  // SDK oficial contra a API real
  let Anthropic;
  try { ({ default: Anthropic } = await import("@anthropic-ai/sdk")); } catch { Anthropic = null; }
  if (Anthropic) {
    const c = new Anthropic({ baseURL: `${BASE}/anthropic`, apiKey: "x", maxRetries: 0 });
    const m = await c.messages.create({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "diga: ok" }] });
    check("SDK anthropic real: create", m.content.some((b) => b.type === "text" && b.text.length > 0));
    const s = c.messages.stream({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "conte 1 2 3" }] });
    for await (const _ of s) {}
    const final = await s.finalMessage();
    check("  stream + finalMessage", final.content.some((b) => b.type === "text" && b.text.length > 0));
    check("  finalMessage.usage.input_tokens > 0", final.usage?.input_tokens > 0, JSON.stringify(final.usage));
  }
}

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  procs.push(startProxy(PROXY_MOCK_PORT, { COMMANDCODE_API_URL: `http://127.0.0.1:${MOCK_PORT}`, COMMAND_CODE_API_KEY: "fake-key" }));
  await waitUp(MOCK_BASE);
  if (RUN_OPENAI) await conformance();
  if (RUN_ANTHROPIC) await anthropicConformance();
  await sdkMock();

  if (!MOCK_ONLY) {
    procs.push(startProxy(PROXY_PORT, {}));
    await waitUp(BASE);
    if (RUN_OPENAI) await real();
    if (RUN_ANTHROPIC) await anthropicReal();
  } else {
    console.log("\n(--mock: testes reais pulados)");
  }

  console.log(`\nResultado: ${passed} ok, ${failed} falhou\n`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("teste quebrou:", e); cleanup(); process.exit(1); });
