#!/usr/bin/env node
// Testes do cc-proxy.
//   node test.mjs          -> conformidade (mock upstream, sem custo) + testes reais (consome crédito)
//   node test.mjs --mock   -> só conformidade, sem tocar em api.commandcode.ai
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_ONLY = process.argv.includes("--mock");
const rnd = () => 8800 + Math.floor(Math.random() * 900);
const MOCK_PORT = rnd(), PROXY_MOCK_PORT = rnd(), PROXY_PORT = rnd();
const MOCK_BASE = `http://127.0.0.1:${PROXY_MOCK_PORT}`;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
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
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 5, outputTokens: 9, totalTokens: 14, inputTokenDetails: { cacheReadTokens: 4 }, outputTokenDetails: { reasoningTokens: 7 } } },
  ],
  "max-tokens": [
    { type: "text-delta", text: "corta" },
    { type: "finish", finishReason: "max_tokens", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
  "abort": [{ type: "text-delta", text: "x" }, { type: "abort" }],
};
let lastUpstreamBody = null;
const mock = createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const body = JSON.parse(b);
  lastUpstreamBody = body;
  const sc = body.params.model;
  if (sc === "http-429") { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "rate limit exceeded" } })); return; }
  if (sc === "http-401") { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Invalid 'Authorization' header" } })); return; }
  if (sc === "not-in-plan") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "model_not_in_plan" } })); return; }
  const evs = SCENARIOS[sc] ?? [{ type: "text-delta", text: "default" }, { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }];
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const txt = evs.map((e) => JSON.stringify(e)).join("\n");
  res.end(sc === "no-trailing-newline" ? txt : txt + "\n");
});

function startProxy(port, extraEnv) {
  const p = spawn(process.execPath, [join(__dirname, "server.mjs")], {
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

// ---------- conformidade (mock, sem custo) ----------
async function conformance() {
  console.log("\n— conformidade OpenAI (mock upstream, sem custo) —");

  // status HTTP mapeado do upstream
  for (const [model, want, code] of [["http-429", 429, "rate_limit_exceeded"], ["http-401", 401, "invalid_api_key"], ["not-in-plan", 404, "model_not_found"]]) {
    const { status, data } = await post(MOCK_BASE, { model, messages: [{ role: "user", content: "x" }] });
    check(`upstream ${model} → HTTP ${want}`, status === want, `status=${status}`);
    check(`  error.code=${code}`, data?.error?.code === code, `code=${data?.error?.code}`);
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
}

// ---------- testes reais (consomem crédito) ----------
async function real() {
  console.log("\n— testes reais contra api.commandcode.ai (consome crédito) —");

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

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  procs.push(startProxy(PROXY_MOCK_PORT, { COMMANDCODE_API_URL: `http://127.0.0.1:${MOCK_PORT}`, COMMAND_CODE_API_KEY: "fake-key" }));
  await waitUp(MOCK_BASE);
  await conformance();

  if (!MOCK_ONLY) {
    procs.push(startProxy(PROXY_PORT, {}));
    await waitUp(BASE);
    await real();
  } else {
    console.log("\n(--mock: testes reais pulados)");
  }

  console.log(`\nResultado: ${passed} ok, ${failed} falhou\n`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("teste quebrou:", e); cleanup(); process.exit(1); });
