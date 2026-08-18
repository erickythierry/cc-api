# commandcode-re

Engenharia reversa do cliente npm **command-code** (`api.commandcode.ai`) e um **proxy compatível com
OpenAI e Anthropic** para usar o plano **Go ($1/mês)** como API — sem o TUI do CLI, sem a API oficial
(que o plano Go não libera).

## O que é

O plano Go do commandcode só permite usar o CLI npm (`npm i -g command-code@latest` + login). Ele não dá
acesso à API oficial. Este repo desmontou o bundle do CLI e extraiu o wire protocol que ele usa — e entrega
um proxy local que converte isso para **formato OpenAI** (`/v1/chat/completions`) **e para o formato
Anthropic** (`/v1/messages`), lado a lado, pra qualquer harness que fale uma das duas línguas (SDK
`openai`, Vercel AI SDK, LiteLLM, aider, `@anthropic-ai/sdk`, etc.) usar direto.

## Estrutura

```
├── PROTOCOLO.md          # spec do wire protocol do commandcode (endpoints, auth, stream)
├── PLANO-ANTHROPIC.md    # plano de implementação do dialeto Anthropic (executado)
├── test-client.mjs       # client direto contra api.commandcode.ai (sem TUI) — teste cru do protocolo
└── cc-proxy/             # ⭐ o projeto usável: proxy local OpenAI + Anthropic
    ├── server.ts         # boot, roteador HTTP, CORS (zero dependências de runtime, node:http)
    ├── upstream.ts       # camada comum: auth, wire do commandcode, SSE, erros
    ├── openai.ts         # dialeto OpenAI (/v1/chat/completions)
    ├── anthropic.ts      # dialeto Anthropic (/v1/messages, count_tokens)
    ├── models.ts         # catálogo de modelos
    ├── tsconfig.json     # strict + erasableSyntaxOnly (Node roda os .ts sem build)
    ├── test.mjs          # suite de testes (mock + SDKs oficiais + reais)
    ├── package.json
    └── README.md         # doc de uso do proxy
```

## Como funciona

```
harness (OpenAI ou Anthropic) ──► cc-proxy :8787 ──► api.commandcode.ai/alpha/generate
                                   sem auth local      (Bearer key de ~/.commandcode/auth.json)
```

1. **Login** (uma vez): `command-code login` grava a key em `~/.commandcode/auth.json`.
2. **Sobe o proxy**: `cd cc-proxy && PORT=8787 npm start`.
3. **Aponta o harness**:
   - OpenAI: `baseURL = http://localhost:8787/v1` (ou `/openai/v1`)
   - Anthropic: `baseURL = http://localhost:8787/anthropic` (o SDK acrescenta `/v1/messages`)

O conflito de `GET /v1/models` (existe nos dois padrões, com shapes diferentes) é resolvido pelo
header: `anthropic-version`/`x-api-key` → shape Anthropic; senão OpenAI. Os prefixos
`/openai/*` e `/anthropic/*` forçam o dialeto de forma determinística.

## Validação

- Suite `npm test` (em `cc-proxy/`): **189/189** (142 no modo `--mock`, sem custo). Três partes:
  - **conformidade** (`npm run test:mock`) — upstream falso cobre, nos dois dialetos: erro no meio do
    stream, HTTP 429/401/403, NDJSON sem newline final, tool executada pelo servidor, reasoning/cache,
    stop sequences, validação local, cancelamento, e — no lado Anthropic — a máquina de estado dos
    blocos SSE (texto → tool → texto, índices sequenciais), `tool_result` em mensagem `user`,
    desambiguação de `/v1/models`, `count_tokens`.
  - **SDKs oficiais** (`openai` e `@anthropic-ai/sdk`, só `devDependencies`) contra o mock e contra a
    API real: create, stream + `finalMessage()`, round-trip de tool, erros tipados
    (`RateLimitError`, `NotFoundError`), erro mid-stream que **lança**.
  - **reais** contra `api.commandcode.ai` — chat, stream, tool calls, multi-turn, `response_format`,
    `stop`/`stop_sequences`, variantes de effort, modelo inexistente.
- Plano Go = gate server-side: libera modelos opensource (deepseek, Kimi, GLM, MiniMax, Qwen...), bloqueia premium (Claude/GPT) com `model_not_in_plan`.

### Pegadinha da wire: o system prompt implícito

`/alpha/generate` sem `params.system` faz o servidor injetar o prompt de agente do CLI —
**~7.6k tokens de input por chamada** e o modelo se apresenta como agente de terminal. O proxy
sempre manda um `system`; medido: 7.750 → 97 tokens de input na mesma pergunta.

## Modelos

Default: `deepseek/deepseek-v4-flash`. Catálogo completo em `cc-proxy/models.ts` (extraído do bundle `command-code@1.27.1`).
Modelos com reasoning expõem variantes de esforço por sufixo no id — `deepseek/deepseek-v4-flash-max`,
`-high`, `zai-org/GLM-5.3-low`, etc. — resolvidas no proxy e repassadas como `reasoning_effort` na wire.

## Detalhes da extração

- Base API: `https://api.commandcode.ai` (env `COMMANDCODE_API_URL` sobrepõe).
- Auth: `Authorization: Bearer <key>` — key em `~/.commandcode/auth.json` ou env `COMMAND_CODE_API_KEY`.
- Inferência: `POST /alpha/generate` — request JSON + resposta **NDJSON stream** (1 objeto por linha).
- Endpoints auxiliares: `/alpha/whoami`, `/alpha/billing/*`, `/alpha/usage/summary`, `/alpha/web-search`, `/alpha/web-fetch`, `/alpha/taste/*`, `/alpha/fingerprint/record`.

Tudo documentado em [`PROTOCOLO.md`](./PROTOCOLO.md).

## Requisitos

- Node >= 22.18 (roda os `.ts` do proxy sem build, via type stripping nativo; `fetch` nativo)
- Conta commandcode com plano Go (ou superior) logada
