# cc-proxy

Proxy local que converte a API do **commandcode** (`api.commandcode.ai`) em **dois dialetos ao
mesmo tempo**: **OpenAI** (`/v1/chat/completions`) e **Anthropic** (`/v1/messages`). Qualquer
harness que fale uma das duas línguas funciona apontando a base URL pra cá — sem auth local, sem
chave no harness, sem tocar no TUI.

> Plano Go do commandcode não libera a API oficial. Este proxy usa **a mesma key que o CLI
> grava em `~/.commandcode/auth.json`** e fala direto com o endpoint `/alpha/generate`.

## Como funciona

```
harness (OpenAI ou Anthropic) ──► cc-proxy 127.0.0.1:8787 ──► api.commandcode.ai/alpha/generate
                                    conversão                  (Bearer key de ~/.commandcode/auth.json)
```

### Rotas

| Rota | Dialeto | Nota |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | stream (SSE) e não-stream |
| `POST /v1/messages` | Anthropic | stream (SSE) e não-stream |
| `POST /v1/messages/count_tokens` | Anthropic | estimativa local (ver limitações) |
| `GET /v1/models`, `GET /v1/models/{id}` | ambos | **Anthropic** se o request trouxer `anthropic-version` ou `x-api-key`; senão **OpenAI** |
| `GET /healthz` | comum | health check |
| `/openai/v1/*` | OpenAI forçado | prefixo removido antes do roteamento |
| `/anthropic/v1/*` | Anthropic forçado | prefixo removido antes do roteamento |

Os prefixos existem porque os dois SDKs montam `${baseURL}/v1/...`:

```js
new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" })         // ou /openai/v1
new Anthropic({ baseURL: "http://127.0.0.1:8787/anthropic" }) // o SDK acrescenta /v1/messages
new Anthropic({ baseURL: "http://127.0.0.1:8787" })           // também funciona (o SDK manda x-api-key)
```
- Nenhum auth no proxy. Por isso ele **escuta só em `127.0.0.1`** (a key do commandcode fica
  atrás dele; expor na rede = dar a key pra rede). Para expor de propósito: `HOST=0.0.0.0`.

## Requisitos

- Node >= 18.17 (usa `fetch` nativo)
- Conta commandcode logada: `command-code login` já rodado **ou** env `COMMAND_CODE_API_KEY`

## Instalação e uso

```bash
npm install        # sem deps — só registra scripts
PORT=8787 npm start
# ou:
node server.mjs
```

Ver `http://localhost:8787/healthz`.

### Como apontar um harness

| Harness | Config |
|---|---|
| `openai` SDK / `curl` | `base_url = http://localhost:8787/v1` |
| `@anthropic-ai/sdk` / Claude Code | `baseURL = http://localhost:8787/anthropic` |
| Vercel AI SDK | `createOpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "x" })` |
| LiteLLM | `--api_base http://localhost:8787/v1 --api_key x` |
| aider | `--openai-api-base http://localhost:8787/v1` |

Qualquer `api_key` serve (o proxy ignora e usa a do commandcode).

## Exemplo rápido

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Diz oi em 3 palavras"}]
  }'
```

### Stream

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash",
       "messages":[{"role":"user","content":"conte 1 2 3"}],
       "stream":true}'
```

### Tool calls

O proxy mapeia `tools` OpenAI → tools do commandcode e devolve `tool_calls` no stream/final.
Multi-turn funciona: mande `assistant.tool_calls` + mensagem `role:"tool"` de volta.
Tools executadas pelo próprio servidor do commandcode (`web_search`/`web_fetch`) **não**
aparecem como `tool_calls` — o resultado delas já vem embutido na resposta.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role":"user","content":"Clima em Paris agora"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Clima de uma cidade",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

## Dialeto Anthropic (Messages API)

```bash
curl http://localhost:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: x' -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "max_tokens": 1024,
    "system": "Você é um assistente conciso.",
    "messages": [{"role": "user", "content": "Diz oi em 3 palavras"}]
  }'
```

Stream: mesma chamada com `"stream": true` — SSE no formato Anthropic (`event:` + `data:`,
`message_start` → blocos → `message_delta` → `message_stop`, **sem `[DONE]`**).

```js
import Anthropic from "@anthropic-ai/sdk";
const c = new Anthropic({ baseURL: "http://127.0.0.1:8787/anthropic", apiKey: "x" });
const m = await c.messages.create({
  model: "deepseek/deepseek-v4-flash", max_tokens: 1024,
  messages: [{ role: "user", content: "oi" }],
});
```

> `max_tokens` é **obrigatório** (igual à API real) e conta o reasoning: em modelo com raciocínio,
> `max_tokens` baixo pode devolver `content: []` com `stop_reason: "max_tokens"`. Use ≥ 1024.

Tool use funciona no round-trip completo: o proxy devolve blocos `tool_use` (com `input`
**objeto**), e aceita de volta a mensagem `assistant` com esses blocos + a mensagem `user`
com `tool_result` (que vira `role:"tool"` na wire do commandcode).

### Cobertura do contrato Anthropic

| Campo | Estado |
|---|---|
| `messages` com `content` string ou blocos | ✅ |
| blocos `text`, `image` (base64 e url), `tool_use`, `tool_result` | ✅ |
| `tool_result` em mensagem `user` (inclusive misturado com `text`) | ✅ vira mensagem wire `role:"tool"` antes da `user` |
| `tool_result.is_error` | ✅ value prefixado com `Error: ` (a wire não tem flag) |
| `system` string **ou** array de blocos | ✅ (blocos juntados com `\n\n`) |
| `tools` (`{name, description, input_schema}`) | ✅ shape idêntico ao da wire |
| `tool_choice` | ⚠️ `none` remove as tools; `any`/`tool` viram instrução no system |
| `max_tokens`, `temperature`, `top_p` | ✅ |
| `stop_sequences` | ✅ cortado no proxy — a wire não tem; ao cortar, aborta o upstream |
| `stream` (SSE completo, índices sequenciais, `input_json_delta`) | ✅ |
| `thinking` (`adaptive`/`enabled`) | ⚠️ blocos `thinking` com `signature: ""` (ver limitações) |
| `output_config.effort` / sufixo de effort no id do modelo | ✅ (sufixo tem precedência) |
| `stop_reason` `end_turn`/`tool_use`/`max_tokens`/`stop_sequence` + `stop_sequence` | ✅ |
| `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) | ✅ |
| erros: HTTP + `error.type` Anthropic (`rate_limit_error`, `authentication_error`, `not_found_error`, `api_error`) | ✅ |
| erro no meio do stream | ✅ `event: error` e encerra **sem** `message_stop` (SDK lança) |
| cancelamento (cliente desconecta) | ✅ aborta a geração upstream |
| `GET /v1/models`, `/v1/models/{id}` no shape Anthropic | ✅ |
| `POST /v1/messages/count_tokens` | ⚠️ estimativa local (~±25%), não serve para billing |
| `top_k`, `metadata`, `cache_control`, `service_tier`, `container`, `mcp_servers` | aceitos e ignorados |
| blocos `document` (PDF) | ❌ 400 `invalid_request_error` |
| `/v1/complete`, `/v1/messages/batches`, `/v1/files`, Managed Agents | ❌ fora de escopo |

### Limitações conhecidas (não são bugs)

| Item | Comportamento |
|---|---|
| prompt caching (`cache_control`) | aceito e ignorado; os campos de cache no `usage` refletem o cache do **upstream** |
| blocos `thinking` no request | descartados (a wire não aceita replay de reasoning) |
| `signature` dos blocos `thinking` na resposta | string vazia — serve para leitura, não para replay |
| `usage.input_tokens` no stream | vem no `message_delta` (a wire só entrega usage no fim); `finalMessage().usage` do SDK sai correto |
| `count_tokens` | estimativa por caracteres (`chars/4`) — a wire não expõe tokenizer |
| `anthropic-version` | aceito com qualquer valor, inclusive ausente |
| auth | o proxy **não valida** `x-api-key` (igual ao lado OpenAI); a key real é a do commandcode |

## Testes

```bash
npm test                # conformidade (mock, sem custo) + SDKs + testes reais (consome crédito)
npm run test:mock       # só conformidade + SDKs contra o mock — não toca em api.commandcode.ai
npm run test:anthropic  # só o dialeto Anthropic
npm run test:openai     # só o dialeto OpenAI
```

Estado atual: **178 ok, 0 falhou** (131 no modo `--mock`).

A parte de conformidade sobe um upstream falso e cobre os caminhos que não dá pra provocar de
propósito na API real: erro no meio do stream, HTTP 429/401/403 do upstream, NDJSON sem newline
final, tool executada pelo servidor, contabilidade de reasoning/cache, stop sequences,
`include_usage`, máquina de estado dos blocos SSE (texto → tool → texto) e cancelamento.
Os SDKs oficiais (`openai` e `@anthropic-ai/sdk`, só `devDependencies`) rodam contra o mock e
contra a API real: create, stream + `finalMessage()`, round-trip de tool e erros tipados.

## Arquivos

```
server.mjs      # boot, roteador HTTP, CORS
upstream.mjs    # tudo que fala com o commandcode (comum aos dois dialetos)
openai.mjs      # handlers do dialeto OpenAI
anthropic.mjs   # handlers do dialeto Anthropic
models.mjs      # catálogo de modelos
test.mjs        # suite única (mock + SDKs + reais), com seções por dialeto
```

## Config

| Env | Default | Uso |
|---|---|---|
| `PORT` | `8787` | porta do proxy |
| `HOST` | `127.0.0.1` | interface (só mude sabendo que não há auth) |
| `COMMAND_CODE_API_KEY` | lê `~/.commandcode/auth.json` | key do commandcode |
| `COMMANDCODE_API_URL` | `https://api.commandcode.ai` | upstream |
| `CC_DEFAULT_SYSTEM` | `You are a helpful assistant.` | system usado quando o request não traz nenhum |

### Por que existe um system default

A wire do commandcode é a do CLI: **sem `system` no request, o servidor injeta o prompt de
agente de terminal** — ~7.6k tokens de input por chamada, e o modelo passa a se apresentar como
agente de código com ferramentas de arquivo/bash. O proxy sempre manda um `system` (o do
cliente, se houver; senão o default), o que derruba o input de ~7.750 para ~95 tokens numa
pergunta curta e devolve o comportamento de assistente genérico.

## Modelos e reasoning effort

Catálogo em `models.mjs` (extraído do bundle `command-code@1.27.1`). Plano **Go** libera
opensource (`cai`): deepseek, Kimi, GLM, MiniMax, Qwen, mimo (visão), etc. Modelo premium
(Claude/GPT) no plano Go devolve `model_not_in_plan` do upstream — o proxy repassa como
`404 model_not_found`, igual à OpenAI.

Default: `deepseek/deepseek-v4-flash`.

### Nível de raciocínio via sufixo no id do modelo

Modelos com esforço suportado expõem **variantes** `-low` / `-medium` / `-high` / `-xhigh` / `-max`
no id — cada uma vira um modelo separado na API. O proxy resolve o sufixo e manda
`reasoning_effort` na wire do commandcode. Funciona em qualquer harness (só trocar o id).

```
deepseek/deepseek-v4-flash          # default (sem effort explícito)
deepseek/deepseek-v4-flash-high     # effort=high
deepseek/deepseek-v4-flash-max      # effort=max
deepseek/deepseek-v4-pro-max
zai-org/GLM-5.3-low / -high / -max
```

Esforços válidos por modelo (do bundle): deepseek-v4-pro/flash = `high|max`;
GLM-5.3 = `low|high|max`; GLM-5.2 = `high|max`.

Alternativa: mandar `"reasoning_effort": "high"` no body (OpenAI padrão) num modelo **sem**
sufixo. Sufixo no id tem precedência sobre o body.

No opencode: os modelos-variante aparecem como `commandcode/deepseek/deepseek-v4-flash-max`
em `/models`.

## Cobertura do contrato OpenAI

| Campo | Estado |
|---|---|
| `messages` (system/developer/user/assistant/tool) | ✅ |
| conteúdo multipart + `image_url` (data URI **e** URL http) | ✅ |
| `tools` / `tool_calls` / multi-turn com `role:"tool"` | ✅ |
| `stream` + `stream_options.include_usage` | ✅ (`usage:null` nos chunks, usage no último) |
| `max_tokens` / `max_completion_tokens` | ✅ |
| `temperature`, `top_p` | ✅ |
| `reasoning_effort` (body ou sufixo no id) | ✅ |
| `stop` (string ou array) | ✅ cortado no proxy — a wire não tem; ao cortar, aborta o upstream |
| `response_format` `json_object` / `json_schema` | ⚠️ best-effort: vira instrução no system (a wire não tem modo JSON) |
| `tool_choice` | ⚠️ `none` remove as tools; `required`/nomeado vira instrução no system |
| `usage.prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens` | ✅ |
| `reasoning_content` (convenção deepseek) em `message` e `delta` | ✅ |
| `finish_reason` `stop`/`length`/`tool_calls`/`content_filter` | ✅ |
| erros: HTTP + `error.type`/`error.code` OpenAI (`rate_limit_exceeded`, `invalid_api_key`, `model_not_found`) | ✅ |
| erro no meio do stream | ✅ evento `data: {"error":…}` e encerra **sem** `[DONE]` (SDK lança) |
| cancelamento (cliente desconecta) | ✅ aborta a geração upstream |
| `n > 1` | ❌ 400 explícito (o upstream gera uma resposta por request) |
| `seed`, `logprobs`, `logit_bias`, `frequency_penalty`, `presence_penalty` | aceitos e ignorados (não existem na wire) |
| `POST /v1/responses`, `/v1/completions`, `/v1/embeddings` | ❌ fora de escopo |

## Referência

Protocolo completo do commandcode (extraído por engenharia reversa do bundle npm):
`../PROTOCOLO.md`.
