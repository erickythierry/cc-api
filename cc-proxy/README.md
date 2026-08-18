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

## Modelos

Catálogo em `models.mjs` (extraído do bundle `command-code@1.27.1`). Plano **Go** libera
opensource (`cai`): deepseek, Kimi, GLM, MiniMax, Qwen, mimo (visão), etc. Modelo premium
(Claude/GPT) no plano Go devolve `model_not_in_plan` do upstream — o proxy repassa como
erro `502`.

Default: `deepseek/deepseek-v4-flash`.

## Limitações (de propósito)

- Sem `POST /v1/responses` (só chat/completions) — padrão de facto dos harnesses.
- `tool_choice`, `stop`, `n>1`, `seed`, penalidades: aceitos e ignorados (o wire do
  commandcode não expõe).
- Reasoning interno do modelo não é exposto nos chunks (fora do contrato OpenAI).
- Proxy é stateless: o loop de tool é responsabilidade do harness (igual API OpenAI real).

## Referência

Protocolo completo do commandcode (extraído por engenharia reversa do bundle npm):
`../PROTOCOLO.md`.
