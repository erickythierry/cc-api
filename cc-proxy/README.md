# commandcode-openai-proxy

Proxy local que converte a API do **commandcode** (`api.commandcode.ai`) no **formato OpenAI**.
Qualquer harness que fale a "língua" do OpenAI (`/v1/chat/completions`, `/v1/models`) funciona
apontando a base URL pra cá — sem auth local, sem chave no harness, sem tocar no TUI.

> Plano Go do commandcode não libera a API oficial. Este proxy usa **a mesma key que o CLI
> grava em `~/.commandcode/auth.json`** e fala direto com o endpoint `/alpha/generate`.

## Como funciona

```
harness (OpenAI) ──► cc-proxy :8787 ──► api.commandcode.ai/alpha/generate
                      conversão           (Bearer key de ~/.commandcode/auth.json)
```

- `POST /v1/chat/completions` — stream (SSE) e não-stream
- `GET /v1/models` — catálogo de modelos
- `GET /healthz` — health check
- Nenhum auth no proxy: executa local, só conversão.

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
npm test    # sobe servidor em porta própria, roda a suite, derruba
```

Suite: models, chat não-stream, stream SSE (+`include_usage`), tool call, multi-turn com
tool, system message, endpoints de erro. Consome crédito do plano (janela 5h/6h do Go).

## Config

| Env | Default | Uso |
|---|---|---|
| `PORT` | `8787` | porta do proxy |
| `COMMAND_CODE_API_KEY` | lê `~/.commandcode/auth.json` | key do commandcode |
| `COMMANDCODE_API_URL` | `https://api.commandcode.ai` | upstream |

## Modelos e reasoning effort

Catálogo em `models.mjs` (extraído do bundle `command-code@1.27.1`). Plano **Go** libera
opensource (`cai`): deepseek, Kimi, GLM, MiniMax, Qwen, mimo (visão), etc. Modelo premium
(Claude/GPT) no plano Go devolve `model_not_in_plan` do upstream — o proxy repassa como
erro `502`.

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
google/gemini-3.7-flash-low / -medium / -high
```

Esforços válidos por modelo (do bundle): deepseek-v4-pro/flash = `high|max`;
GLM-5.3 = `low|high|max`; GLM-5.2 = `high|max`; gemini-3.x-flash = `low|medium|high`;
claude-* = `low|medium|high|xhigh|max`.

Alternativa: mandar `"reasoning_effort": "high"` no body (OpenAI padrão) num modelo **sem**
sufixo. Sufixo no id tem precedência sobre o body.

No opencode: os modelos-variante aparecem como `commandcode/deepseek/deepseek-v4-flash-max`
em `/models`.

## Limitações (de propósito)

- Sem `POST /v1/responses` (só chat/completions) — padrão de facto dos harnesses.
- `tool_choice`, `stop`, `n>1`, `seed`, penalidades: aceitos e ignorados (o wire do
  commandcode não expõe).
- Reasoning interno do modelo não é exposto nos chunks (fora do contrato OpenAI).
- Proxy é stateless: o loop de tool é responsabilidade do harness (igual API OpenAI real).

## Referência

Protocolo completo do commandcode (extraído por engenharia reversa do bundle npm):
`../PROTOCOLO.md`.
