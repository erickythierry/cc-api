#!/usr/bin/env node
// Test client direto contra api.commandcode.ai — extraído do bundle do CLI command-code@1.27.1
// Uso: node test-client.mjs [--no-stream] [model]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.COMMANDCODE_API_URL ?? "https://api.commandcode.ai";
const MODEL = process.argv[2] ?? "deepseek/deepseek-v4-flash";

// --- auth: env COMMAND_CODE_API_KEY ou ~/.commandcode/auth.json ---
function getKey() {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8");
    return JSON.parse(raw).apiKey ?? null;
  } catch { return null; }
}
const key = getKey();
if (!key) { console.error("Sem API key. Rode `command-code login` ou export COMMAND_CODE_API_KEY"); process.exit(1); }

// headers espelhando buildCommandAuthHeaders do bundle
const headers = {
  "Content-Type": "application/json",
  "User-Agent": "cli",
  "Authorization": `Bearer ${key}`,
  "x-command-code-version": "1.27.1",
  "x-cli-environment": "production",
  "x-project-slug": "commandCode",
  "x-taste-learning": "false",
  "x-co-flag": "false",
  "x-session-id": crypto.randomUUID(),
};

const baseHeaders = { method: "GET", headers };
async function getJSON(path) {
  const r = await fetch(`${BASE}${path}`, baseHeaders);
  console.log(`\n=== ${path} → ${r.status} ===`);
  if (!r.ok) { console.log(await r.text()); return; }
  console.log(JSON.stringify(await r.json(), null, 2));
}

await getJSON("/alpha/whoami");
await getJSON("/alpha/billing/subscriptions");
await getJSON("/alpha/billing/credits");
await getJSON("/alpha/usage/summary");

// --- config do servidor (buildServerConfig do bundle) ---
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
function git(arg) { try { return execFileSync("git", arg, { encoding: "utf8" }).trim(); } catch { return null; } }
const isGit = !!git(["rev-parse", "--git-dir"]);
const structure = readdirSync(process.cwd()).filter((f) => !f.startsWith(".")).sort();
const config = {
  workingDir: process.cwd(),
  date: new Date().toISOString().split("T")[0],
  environment: process.platform,
  structure,
  isGitRepo: isGit,
  currentBranch: isGit ? (git(["branch", "--show-current"]) ?? "") : "",
  mainBranch: isGit ? (git(["branch", "-r"]).includes("origin/main") ? "main" : git(["branch", "-r"]).includes("origin/master") ? "master" : "main") : "",
  gitStatus: isGit ? (git(["status", "--porcelain"]) || "Working tree clean") : "",
  recentCommits: isGit ? (git(["log", "--oneline", "-3"])?.split("\n") ?? []) : [],
};

// --- /alpha/generate (inferência) ---
console.log(`\n=== POST /alpha/generate model=${MODEL} ===`);
const body = {
  config,
  memory: null,
  taste: null,
  skills: null,
  permissionMode: "standard",
  threadId: crypto.randomUUID(),
  mode: "agent",
  params: {
    model: MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "Say hello in exactly 5 words." }] }],
    tools: [],
    system: "You are a helpful assistant.",
    max_tokens: 64000,
    stream: true,
  },
};

const res = await fetch(`${BASE}/alpha/generate`, { method: "POST", headers, body: JSON.stringify(body) });
console.log(`status: ${res.status}`);
if (!res.ok) { console.log(await res.text()); process.exit(1); }

const reader = res.body.getReader();
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
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "text-delta") process.stdout.write(ev.text ?? "");
    else if (ev.type === "reasoning-delta") process.stdout.write(`[r:${ev.text}]`);
    else if (ev.type === "tool-call") console.log(`\n[tool-call] ${ev.toolName}: ${JSON.stringify(ev.input ?? ev.args)}`);
    else if (ev.type === "finish") console.log(`\n[finish] ${JSON.stringify(ev.totalUsage ?? {})} rawFinishReason=${ev.rawFinishReason}`);
    else if (ev.type === "error") console.log(`\n[error] ${JSON.stringify(ev)}`);
    else if (ev.type !== "abort") console.log(`\n[${ev.type}]`);
  }
}
console.log("\n");
