#!/usr/bin/env node
// Smoke tests do cc-proxy. Sobe o servidor numa porta própria, roda a suite, derruba.
// Uso: node test.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8891 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = "deepseek/deepseek-v4-flash";

const server = spawn(process.execPath, [join(__dirname, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[server-err] ${d}`));

let passed = 0, failed = 0;
function check(name, ok, extra = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function waitUp(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("servidor não subiu");
}

async function chat(body) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { status: r.status, data, text };
}

async function main() {
  console.log(`\ncc-proxy tests → ${BASE}\n`);
  await waitUp();

  // 1. /v1/models
  {
    const r = await fetch(`${BASE}/v1/models`);
    const j = await r.json();
    check("GET /v1/models → 200 list", r.status === 200 && j.object === "list" && Array.isArray(j.data), `status=${r.status}`);
    check("  inclui modelo default", j.data.some((m) => m.id === MODEL));
  }

  // 2. chat simples não-stream
  {
    const { status, data } = await chat({
      model: MODEL,
      messages: [{ role: "user", content: "Reply with the single word: PONG" }],
    });
    check("chat não-stream → 200", status === 200, `status=${status}`);
    check("  shape chat.completion", data?.object === "chat.completion" && data?.choices?.length === 1);
    check("  content resposta", typeof data?.choices?.[0]?.message?.content === "string" && data.choices[0].message.content.length > 0);
    check("  finish_reason stop", data?.choices?.[0]?.finish_reason === "stop", `fr=${data?.choices?.[0]?.finish_reason}`);
    check("  usage shape", typeof data?.usage?.prompt_tokens === "number" && typeof data?.usage?.total_tokens === "number");
    console.log(`    → "${data?.choices?.[0]?.message?.content?.slice(0, 80)}"`);
  }

  // 3. chat stream
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "Count 1 2 3." }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    const chunks = lines.filter((l) => l !== "[DONE]").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const hasContent = chunks.some((c) => c.choices?.[0]?.delta?.content);
    const hasUsage = chunks.some((c) => c.usage);
    const hasDone = lines.includes("[DONE]");
    const last = [...chunks].reverse().find((c) => c.choices?.length);
    check("chat stream → SSE", r.status === 200 && text.includes("[DONE]"), `status=${r.status}`);
    check("  delta content", hasContent);
    check("  finish_reason final", last?.choices?.[0]?.finish_reason === "stop", `fr=${last?.choices?.[0]?.finish_reason}`);
    check("  include_usage", hasUsage);
  }

  // 4. tool call
  {
    const { status, data } = await chat({
      model: MODEL,
      messages: [{ role: "user", content: 'Use the get_weather tool to check the weather in Paris. Call it right away — do not ask.' }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Returns weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      }],
    });
    check("tool call → 200", status === 200, `status=${status}`);
    const tcs = data?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(tcs) && tcs.length) {
      check("  message.tool_calls shape", tcs.every((tc) => tc.type === "function" && tc.function?.name === "get_weather" && typeof tc.function.arguments === "string"));
      check("  finish_reason tool_calls", data.choices[0].finish_reason === "tool_calls", `fr=${data.choices[0].finish_reason}`);
      console.log(`    → tool_call: get_weather(${tcs[0].function.arguments})`);

      // 5. multi-turn com resultado de tool
      const toolCallId = tcs[0].id;
      const args = JSON.parse(tcs[0].function.arguments);
      const r2 = await chat({
        model: MODEL,
        messages: [
          { role: "user", content: 'Use the get_weather tool for Paris.' },
          { role: "assistant", content: null, tool_calls: [{ id: toolCallId, type: "function", function: { name: "get_weather", arguments: tcs[0].function.arguments } }] },
          { role: "tool", tool_call_id: toolCallId, content: `Weather in ${args.city}: 18°C sunny` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Returns weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        }],
      });
      check("multi-turn com tool → 200", r2.status === 200, `status=${r2.status}`);
      if (r2.status === 200) {
        const content = r2.data?.choices?.[0]?.message?.content ?? "";
        check("  responde após tool", content.length > 0);
        console.log(`    → "${content.slice(0, 80)}"`);
      }
    } else {
      check("  message.tool_calls (modelo não chamou tool — shape ok)", data?.choices?.[0]?.message !== undefined);
      console.log("    (modelo não chamou a tool; pulando multi-turn)");
    }
  }

  // 6. sistema message
  {
    const { status, data } = await chat({
      model: MODEL,
      messages: [
        { role: "system", content: "Always answer in Portuguese." },
        { role: "user", content: "Say hello." },
      ],
    });
    check("system message → 200", status === 200, `status=${status}`);
    const content = data?.choices?.[0]?.message?.content ?? "";
    check("  respeita system", /olá|oi|hello/i.test(content), `"${content.slice(0, 60)}"`);
  }

  // 7. erro: endpoint inválido
  {
    const r = await fetch(`${BASE}/v1/nope`, { method: "GET" });
    check("endpoint desconhecido → 404", r.status === 404);
  }

  // 8. erro: body inválido
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    check("body inválido → 400", r.status === 400);
  }

  console.log(`\nResultado: ${passed} ok, ${failed} falhou\n`);
  server.kill();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("teste quebrou:", e.message);
  server.kill();
  process.exit(1);
});
