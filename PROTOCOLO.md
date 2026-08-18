# Protocolo commandcode.ai — extraído do bundle `command-code@1.27.1`

Reverse engineering do cliente npm `command-code` (bundle `dist/cli.mjs`, minificado).
Objetivo: usar o plano **Go ($1)** via API direta, sem passar pelo TUI.

## Camadas

| Camada | Valor |
|---|---|
| API prod | `https://api.commandcode.ai` |
| API staging | `https://staging-api.commandcode.ai` (env `COMMANDCODE_API_ENV=staging`) |
| API local | `http://localhost:9090` (env `COMMANDCODE_API_URL`, `COMMANDCODE_SANDBOX=true`) |
| Studio (web) | `https://commandcode.ai` |

Override de base: env `COMMANDCODE_API_URL`. Env de env: `COMMANDCODE_API_ENV=staging`.

## Auth

- Env: `COMMAND_CODE_API_KEY`
- OU arquivo `~/.commandcode/auth.json`:
  ```json
  { "apiKey": "...", "userId": "...", "userName": "...", "keyName": "...", "authenticatedAt": "..." }
  ```
- `command-code login` → abre `https://commandcode.ai/studio/auth/cli?callback=<porta-local>` (OAuth, callback em `127.0.0.1`), grava o arquivo acima.
- Key é só o `Authorization: Bearer`. Sem refresh token no arquivo (token = apiKey persistente).

## Headers padrão (todos os requests `/alpha/*`)

```
Content-Type: application/json
User-Agent: cli
Authorization: Bearer <apiKey>
x-command-code-version: <versão do CLI>
x-cli-environment: production|staging|local
x-project-slug: <nome do dir do projeto>
x-taste-learning: true|false
x-co-flag: true|false            (flag interno time; pode mandar false)
x-session-id: <uuid>
x-oss-primary-provider: <nome>    (opcional)
x-cmd-zdr: 1                       (opcional, zero-data-retention)
x-oauth-token: Bearer <...>        (só se logado por OAuth de provider)
traceparent: 00-<traceId>-<spanId>-01  (opcional, OpenTelemetry)
```

## Endpoints (base = API prod)

| Método | Path | Uso |
|---|---|---|
| GET | `/alpha/whoami` | usuário (`userName`, `email`, org) |
| GET | `/alpha/namespaces` | orgs do usuário |
| GET | `/alpha/billing/subscriptions` | plano ativo (`planId` tipo `individual-go`) |
| GET | `/alpha/billing/credits` | créditos comprados/gratuitos |
| GET | `/alpha/usage/summary?orgId=&since=` | uso/consumo |
| **POST** | **`/alpha/generate`** | **inferência LLM (stream NDJSON)** |
| POST | `/alpha/web-search` | tool `web_search` server-side |
| POST | `/alpha/web-fetch` | tool `web_fetch` server-side |
| POST | `/alpha/agent/generate` | gera def de subagent |
| POST | `/alpha/taste/:projectSlug` | taste learning |
| POST | `/alpha/learn` | aprender preferências |
| POST | `/alpha/fingerprint/record` | fingerprint máquina |
| POST | `/alpha/lifecycle-events` | telemetria |
| POST | `/alpha/share/create|delete|append` | compartilhar sessão |
| POST | `/alpha/sandbox/start|stream` | sandbox remota |
| POST | `/alpha/devrel-thread/*` | devrel |

## POST /alpha/generate (o request de inferência)

```json
{
  "config": {
    "workingDir": "/abs/path",
    "date": "2026-08-18",
    "environment": "linux",
    "structure": ["node_modules", "src", "package.json", "..."],
    "isGitRepo": true,
    "currentBranch": "main",
    "mainBranch": "main",
    "gitStatus": "Working tree clean",
    "recentCommits": ["abc123 feat", "..."]
  },
  "memory": null,
  "taste": null,
  "skills": null,
  "permissionMode": "standard",
  "threadId": "<uuid obrigatório>",
  "mode": "agent",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [ ... ],
    "tools": [ ... ],
    "system": "...",
    "max_tokens": 64000,
    "stream": true,
    "temperature": 0.7,
    "reasoning_effort": "medium"
  }
}
```

Validação server-side (Zod, descoberta por tentativa e erro — 400 HINT):
- `config` obrigatório com `workingDir` (string), `date` (string), `environment` (string), `structure` (array), `isGitRepo` (bool), `currentBranch`, `mainBranch`, `gitStatus` (strings), `recentCommits` (array).
- `mode` ∈ `agent | learning | custom-agent | custom-agent-create | title-gen | tool-desc | compact | vision`. Chat normal = `agent`.
- `threadId` = UUID válido (não aceita null/"").
- `config.structure` = ls do cwd (sem `.` e sem node_modules etc) + labels `scope:<dir>`.
- `gitStatus` default `"Working tree clean"` quando repo limpo.

### Formato das mensagens (wire)

- `assistant`: `{ role:"assistant", content:[ {type:"text",text} | {type:"tool-call",toolCallId,toolName,input} | {type:"reasoning",text} ] }`
- `user`: `{ role:"user", content:[ {type:"text",text} | {type:"image",image:"data:image/png;base64,...",mimeType} ] }`
- `tool`: `{ role:"tool", content:[ {type:"tool-result",toolCallId,toolName,output} ] }`

### Resposta: stream NDJSON (1 JSON por linha)

| type | campos |
|---|---|
| `start` | início do stream |
| `start-step` | início de step |
| `text-start` / `text-delta` / `text-end` | `text` (delta) |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | `text` (delta) |
| `tool-call` | `toolName`, `toolCallId`, `input` (ou `args`), `providerExecuted` |
| `tool-result` | `toolCallId`, `toolName`, `output` (tool executada pelo server) |
| `finish-step` | fim de step |
| `finish` | `totalUsage:{inputTokens,outputTokens,inputTokenDetails:{cacheReadTokens,cacheWriteTokens},...}`, `rawFinishReason`, `finishReason`, `systemPromptTokens` |
| `provider-metadata` | metadata do provider |
| `error` | `error:{message,statusCode,isRetryable}` (ou string) |
| `abort` | termina silencioso |

Testado real (plano Go, deepseek-v4-flash): reasoning → texto → `finish` com
`{inputTokens:97, outputTokens:78 (text 8 + reasoning 70), totalTokens:175}`.

`finishReason` normalizado: `tool_calls`→`tool_calls`, `length`→`max_tokens`, senão `end_turn`.

## Planos e modelos (server-side)

- Plano Go = `individual-go` → só modelos **opensource** (`provider:"cai"`).
- Providers upstream: `anthropic` (Claude), `openai` (GPT), `openrouter`, `vercel-ai-gateway`, `cai` (Command AI, open).
- O plano Go **bloqueia** premium (Claude/GPT). A lista de modelos conhecidos inclui
  `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `moonshotai/Kimi-K2.5`, `zai-org/GLM-5.2`,
  `MiniMaxAI/MiniMax-M3`, `Qwen/Qwen3.7-Max`, `xiaomi/mimo-v2.5`, etc.
- Modelos feature (fallback/taste/compaction): deepseek-v4-flash (default), deepseek-v4-pro (compaction), mimo-v2.5 (visão).
- Context windows: deepseek-v4-* = 1M, claude-* = 1M, haiku = 200k, etc.
- A verificação de plano é **no servidor** (`model_not_in_plan`, `premium_credits_exhausted`).

## Erros típicos (do cliente)

- `401` / `Invalid 'Authorization' header` → key inválida.
- `model_not_in_plan` → modelo não incluído no plano.
- `premium_credits_exhausted` → créditos premium esgotados.
- `insufficient credits` / `usage window limit` / `rate limit` → limites de plano.

## Como testar

1. `command-code login` (uma vez, browser) — grava `~/.commandcode/auth.json`.
2. `node test-client.mjs` — roda whoami + billing + generate direto.
3. `COMMAND_CODE_API_KEY=xxx node test-client.mjs <model>` — key via env.

Nota: key extraída do CLI é a mesma usada no `api.commandcode.ai`. Plano Go
permite só modelos opensource (`deepseek/deepseek-v4-flash` é o default).
