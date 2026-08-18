# commandcode-openai-proxy

Proxy local que converte a API do **commandcode** (`api.commandcode.ai`) no **formato OpenAI**.
Qualquer harness que fale a "língua" do OpenAI (`/v1/chat/completions`, `/v1/models`) funciona
apontando a base URL pra cá — sem auth local, sem chave no harness, sem tocar no TUI.

> Plano Go do commandcode não libera a API oficial. Este proxy usa **a mesma key que o CLI
> grava em `~/.commandcode/auth.json`** e fala direto com o endpoint `/alpha/generate`.

## Como funciona

```
harness (OpenAI) ──► cc-proxy 127.0.0.1:8787 ──► api.commandcode.ai/alpha/generate
                       conversão                  (Bearer key de ~/.commandcode/auth.json)
```

- `POST /v1/chat/completions` — stream (SSE) e não-stream
- `GET /v1/models` e `GET /v1/models/{id}` — catálogo
- `GET /healthz` — health check
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

## Testes

```bash
npm test           # conformidade (mock upstream, sem custo) + testes reais (consome crédito)
npm run test:mock  # só conformidade — não toca em api.commandcode.ai
```

A parte de conformidade sobe um upstream falso e cobre os caminhos que não dá pra provocar de
propósito na API real: erro no meio do stream, HTTP 429/401/403 do upstream, NDJSON sem newline
final, tool executada pelo servidor, contabilidade de reasoning/cache, `stop`, `include_usage`.

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
