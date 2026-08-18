# commandcode-re

Engenharia reversa do cliente npm **command-code** (`api.commandcode.ai`) e um **proxy OpenAI-compatible**
para usar o plano **Go ($1/mês)** como API — sem o TUI do CLI, sem a API oficial (que o plano Go não libera).

## O que é

O plano Go do commandcode só permite usar o CLI npm (`npm i -g command-code@latest` + login). Ele não dá
acesso à API oficial. Este repo desmontou o bundle do CLI e extraiu o wire protocol que ele usa — e entrega
um proxy local que converte isso para **formato OpenAI**, pra qualquer harness que fale a língua do OpenAI
(SDK `openai`, Vercel AI SDK, LiteLLM, aider, etc.) usar direto.

## Estrutura

```
├── PROTOCOLO.md          # spec do wire protocol do commandcode (endpoints, auth, stream)
├── test-client.mjs       # client direto contra api.commandcode.ai (sem TUI) — teste cru do protocolo
└── cc-proxy/             # ⭐ o projeto usável: proxy local OpenAI-compatible
    ├── server.mjs        # servidor (zero dependências, node:http)
    ├── models.mjs        # catálogo de modelos
    ├── test.mjs          # suite de testes (conformidade com mock + reais)
    ├── package.json
    └── README.md         # doc de uso do proxy
```

## Como funciona

```
harness (OpenAI) ──► cc-proxy :8787 ──► api.commandcode.ai/alpha/generate
                      sem auth local      (Bearer key de ~/.commandcode/auth.json)
```

1. **Login** (uma vez): `command-code login` grava a key em `~/.commandcode/auth.json`.
2. **Sobe o proxy**: `cd cc-proxy && PORT=8787 npm start`.
3. **Aponta o harness**: `baseURL = http://localhost:8787/v1`.

## Validação

- Suite `npm test` (em `cc-proxy/`): **61/61**. Duas partes:
  - **conformidade** (`npm run test:mock`, sem custo) — upstream falso cobre erro no meio do stream,
    HTTP 429/401/403, NDJSON sem newline final, tool executada pelo servidor, reasoning/cache,
    `stop`, `include_usage`, validação local.
  - **reais** contra `api.commandcode.ai` — chat, stream, tool calls, multi-turn, `response_format`,
    variantes de effort, modelo inexistente.
- Teste com **SDK oficial `openai`**: `chat.completions.create`, stream, `tool_calls`,
  `models.list`, `models.retrieve`, erros tipados (`RateLimitError`, `NotFoundError`).
- Plano Go = gate server-side: libera modelos opensource (deepseek, Kimi, GLM, MiniMax, Qwen...), bloqueia premium (Claude/GPT) com `model_not_in_plan`.

### Pegadinha da wire: o system prompt implícito

`/alpha/generate` sem `params.system` faz o servidor injetar o prompt de agente do CLI —
**~7.6k tokens de input por chamada** e o modelo se apresenta como agente de terminal. O proxy
sempre manda um `system`; medido: 7.750 → 97 tokens de input na mesma pergunta.

## Modelos

Default: `deepseek/deepseek-v4-flash`. Catálogo completo em `cc-proxy/models.mjs` (extraído do bundle `command-code@1.27.1`).
Modelos com reasoning expõem variantes de esforço por sufixo no id — `deepseek/deepseek-v4-flash-max`,
`-high`, `zai-org/GLM-5.3-low`, etc. — resolvidas no proxy e repassadas como `reasoning_effort` na wire.

## Detalhes da extração

- Base API: `https://api.commandcode.ai` (env `COMMANDCODE_API_URL` sobrepõe).
- Auth: `Authorization: Bearer <key>` — key em `~/.commandcode/auth.json` ou env `COMMAND_CODE_API_KEY`.
- Inferência: `POST /alpha/generate` — request JSON + resposta **NDJSON stream** (1 objeto por linha).
- Endpoints auxiliares: `/alpha/whoami`, `/alpha/billing/*`, `/alpha/usage/summary`, `/alpha/web-search`, `/alpha/web-fetch`, `/alpha/taste/*`, `/alpha/fingerprint/record`.

Tudo documentado em [`PROTOCOLO.md`](./PROTOCOLO.md).

## Requisitos

- Node >= 18.17 (`fetch` nativo)
- Conta commandcode com plano Go (ou superior) logada
