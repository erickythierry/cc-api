# Plano — compatibilidade com a API Anthropic (Messages API) no cc-proxy

Documento de implementação. Público: agente/dev que vai **implementar, testar e validar**.
Estado atual: o `cc-proxy` traduz OpenAI ↔ wire do commandcode com 61/61 testes verdes.
Objetivo: **um único proxy que fala os dois dialetos** — OpenAI (`/v1/chat/completions`) e
Anthropic (`/v1/messages`) — contra o mesmo upstream `POST /alpha/generate`.

Leitura obrigatória antes de codar: `PROTOCOLO.md` (wire do commandcode) e `cc-proxy/server.mjs`.

---

## 1. Escopo

### Entra

| Endpoint | Método | Nota |
|---|---|---|
| `/v1/messages` | POST | stream (SSE) e não-stream |
| `/v1/messages/count_tokens` | POST | estimativa local (ver §8) |
| `/v1/models` | GET | shape Anthropic; desambiguação com o de OpenAI em §3.2 |
| `/v1/models/{id}` | GET | shape Anthropic |

### Não entra (fora de escopo, documentar como tal)

`/v1/complete` (Text Completions legado), `/v1/messages/batches`, `/v1/files`, `/v1/skills`,
Managed Agents (`/v1/agents`, `/v1/sessions`), prompt caching real (`cache_control` é aceito e
ignorado), `container`, `mcp_servers`, `fallbacks`, `service_tier`, Vertex/Bedrock.

### Regra que não muda

**Zero dependências de runtime.** O proxy roda em `node:http` puro. SDKs (`openai`,
`@anthropic-ai/sdk`) entram só como `devDependencies` para os testes de validação.

---

## 2. O que já existe e deve ser reusado

`cc-proxy/server.mjs` hoje (638 linhas, tudo num arquivo):

| Linha | Símbolo | Reuso |
|---|---|---|
| 24 | `getKey()` | comum |
| 40 | `SERVER_CONFIG` | comum |
| 53 | `authHeaders(sessionId)` | comum |
| 185 | `toWireTools(tools)` | **quase idêntico** — o shape Anthropic `{name, description, input_schema}` já é o shape da wire |
| 220 | `finishReasonOf(wireFinish)` | específico OpenAI; Anthropic precisa do seu (§6) |
| 229 | `usageOf(u)` | específico OpenAI; Anthropic precisa do seu (§6) |
| 245 | `makeStopFilter(stops)` | comum — **precisa de 1 alteração**, ver §4.6 |
| 268 | `mapUpstreamError(status, msg)` | comum — **precisa de refactor**, ver §7 |
| 282 | `readBody(req)` | comum |
| 292 | `readEvents(readable)` | comum (parser NDJSON, já com flush da última linha) |
| 315 | `json(res, status, obj)` | comum |
| 367+ | corpo do handler `/v1/chat/completions` | modelo a seguir: montagem do body, `AbortController` em `res.close`, `handleStream`, tratamento de erro |

Comportamentos do handler atual que **têm que se repetir** no dialeto Anthropic (foram bugs
corrigidos com teste; não regredir):

1. `params.system` **sempre** enviado (sem ele o upstream injeta ~7.6k tokens de prompt de agente).
2. `config` neutra (não vaza cwd/git do usuário).
3. `AbortController` ligado a `res.on("close")` → cancela a geração upstream.
4. Evento wire `tool-call` com `providerExecuted: true` é descartado (tool do servidor).
5. Erro no meio do stream **não** pode terminar como sucesso.
6. Última linha NDJSON sem `\n` tem que ser processada (é a que traz o `finish`/usage).
7. Status HTTP do upstream mapeado (429 continua 429).

---

## 3. Arquitetura

### 3.1 Divisão de arquivos

Um arquivo com dois dialetos fica ilegível. Divisão mínima (4 arquivos, sem camadas extras):

```
cc-proxy/
├── server.mjs      # boot, roteador HTTP, CORS, helpers de resposta
├── upstream.mjs    # tudo que fala com o commandcode (comum aos dois dialetos)
├── openai.mjs      # handlers do dialeto OpenAI (movido de server.mjs, sem mudança de comportamento)
├── anthropic.mjs   # handlers do dialeto Anthropic (novo)
├── models.mjs      # catálogo (inalterado)
└── test.mjs        # suite única, com seções por dialeto
```

`upstream.mjs` exporta:

```js
export const SERVER_CONFIG          // config neutra
export const DEFAULT_SYSTEM         // string
export function authHeaders(sessionId)
export function buildGenerateBody({ model, messages, system, tools, maxTokens, temperature, topP, reasoningEffort })
export async function callUpstream(generateBody, signal)   // -> Response (fetch)
export async function* readEvents(readable)                // NDJSON -> objetos
export function makeStopFilter(stops)
export function classifyUpstreamError(status, message)     // -> kind (ver §7)
```

`openai.mjs` e `anthropic.mjs` exportam cada um `handle(req, res, url)` → `true` se tratou a
rota, `false` se não é dele. `server.mjs` só encadeia.

**Ordem obrigatória do refactor:** mover o OpenAI para `openai.mjs` **primeiro**, rodar
`npm test` e confirmar 61/61, e só depois começar o Anthropic. Um refactor e uma feature no
mesmo commit escondem a regressão.

### 3.2 Roteamento e o conflito de `/v1/models`

`/v1/messages` só existe na Anthropic e `/v1/chat/completions` só na OpenAI — sem conflito.
O conflito é `GET /v1/models`, que existe nos dois com shapes diferentes.

Regra a implementar:

| Path | Dialeto |
|---|---|
| `/openai/v1/*` | força OpenAI (prefixo removido antes do roteamento) |
| `/anthropic/v1/*` | força Anthropic (prefixo removido antes do roteamento) |
| `/v1/chat/completions`, `/v1/completions` | OpenAI |
| `/v1/messages`, `/v1/messages/count_tokens` | Anthropic |
| `/v1/models`, `/v1/models/{id}` | **Anthropic** se o request trouxer header `anthropic-version` **ou** `x-api-key`; senão **OpenAI** |
| `/healthz` | comum |

Os prefixos existem porque os dois SDKs montam `${baseURL}/v1/...`:

```js
new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" })              // ou /openai/v1
new Anthropic({ baseURL: "http://127.0.0.1:8787/anthropic" })     // SDK acrescenta /v1/messages
new Anthropic({ baseURL: "http://127.0.0.1:8787" })               // também funciona (heurística de header)
```

O SDK Anthropic sempre manda `x-api-key`, então a heurística acerta na prática; o prefixo é a
saída determinística para quem não quer depender disso.

---

## 4. Request Anthropic → wire do commandcode

### 4.1 Body de entrada

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "max_tokens": 1024,
  "system": "string OU [{\"type\":\"text\",\"text\":\"...\"}]",
  "messages": [{ "role": "user|assistant", "content": "string OU [blocos]" }],
  "tools": [{ "name": "...", "description": "...", "input_schema": {...} }],
  "tool_choice": { "type": "auto|any|tool|none", "name": "..." },
  "stop_sequences": ["..."],
  "temperature": 0.7, "top_p": 0.9, "top_k": 40,
  "stream": true,
  "thinking": { "type": "adaptive|enabled|disabled", "budget_tokens": 1024 },
  "output_config": { "effort": "low|medium|high|xhigh|max" },
  "metadata": { "user_id": "..." }
}
```

### 4.2 Validação local (antes de gastar quota)

| Condição | Resposta |
|---|---|
| `model` ausente/não-string | 400 `invalid_request_error` — `"model: field required"` |
| `max_tokens` ausente, não-inteiro, ou < 1 | 400 `invalid_request_error` — `"max_tokens: field required"` |
| `messages` ausente/vazio | 400 `invalid_request_error` — `"messages: at least one message is required"` |
| body não é JSON | 400 `invalid_request_error` |

Não validar alternância de roles: a wire aceita consecutivos e a API real também os combina.

### 4.3 `system` → `params.system`

- string → usa direto
- array de blocos → junta os `.text` dos blocos `type:"text"` com `\n\n`
- ausente/vazio → **`DEFAULT_SYSTEM`** (regra não-negociável, §2 item 1)
- `cache_control` nos blocos: ignorar

Instruções derivadas de `tool_choice` (§4.5) são anexadas ao final do system, separadas por `\n\n`.

### 4.4 Blocos de conteúdo → wire

Wire de referência (`PROTOCOLO.md`):

```
assistant: { role:"assistant", content:[ {type:"text",text} | {type:"tool-call",toolCallId,toolName,input} ] }
user:      { role:"user",      content:[ {type:"text",text} | {type:"image",image:"data:...",mimeType} ] }
tool:      { role:"tool",      content:[ {type:"tool-result",toolCallId,toolName,output:{type:"text",value}} ] }
```

Tabela de conversão:

| Anthropic (bloco) | Onde aparece | Wire |
|---|---|---|
| string em `content` | user/assistant | `[{type:"text",text:<string>}]` |
| `{type:"text",text}` | user/assistant | `{type:"text",text}` |
| `{type:"image",source:{type:"base64",media_type,data}}` | user | `{type:"image",image:"data:<media_type>;base64,<data>",mimeType:<media_type>}` |
| `{type:"image",source:{type:"url",url}}` | user | baixar e converter para data URI (reusar a lógica de `imageUrlToDataUri`, hoje em `server.mjs:88`) |
| `{type:"tool_use",id,name,input}` | assistant | `{type:"tool-call",toolCallId:id,toolName:name,input}` |
| `{type:"tool_result",tool_use_id,content,is_error}` | **user** | vira mensagem wire `role:"tool"` — ver §4.4.1 |
| `{type:"thinking"}` / `{type:"redacted_thinking"}` | assistant | **descartar** (a wire não aceita replay de reasoning) |
| `{type:"document"}` | user | não suportado → 400 `invalid_request_error` explicando |

#### 4.4.1 A pegadinha principal: `tool_result` vem em mensagem `user`

Na Anthropic o resultado da tool volta dentro de uma mensagem `role:"user"`; na wire ele é uma
mensagem `role:"tool"` separada. Uma mensagem `user` pode misturar `tool_result` e `text`, e a
Anthropic exige os `tool_result` primeiro.

Algoritmo por mensagem `user`:

1. Separar blocos em `toolResults` e `resto`.
2. Se `toolResults` não vazio → emitir **uma** mensagem wire `{role:"tool", content:[...tool-results]}`.
3. Se `resto` não vazio → emitir **em seguida** `{role:"user", content:[...]}`.
4. Se ambos vazios → não emitir nada.

`toolName` do `tool-result`: resolver pelo `tool_use_id` varrendo os blocos `tool_use` das
mensagens assistant anteriores (mesma ideia de `buildToolNameMap`, `server.mjs:107`, mas lendo
blocos `tool_use` em vez de `tool_calls`). Sem match → `"unknown"`.

`tool_result.content`:
- string → `output:{type:"text",value:<string>}`
- array de blocos → concatenar os `text` com `\n`
- `is_error: true` → prefixar o value com `"Error: "` (a wire não tem flag de erro)

Mensagem `assistant` com zero blocos aproveitáveis: **não emitir** (assistant vazio quebra a
validação Zod do upstream — mesmo cuidado já existe no lado OpenAI).

### 4.5 Parâmetros

| Anthropic | Wire / ação |
|---|---|
| `max_tokens` | `params.max_tokens` (obrigatório, sem default) |
| `temperature` | `params.temperature` |
| `top_p` | `params.top_p` |
| `top_k` | ignorar (não existe na wire) |
| `stop_sequences` | **não vai pra wire** — corte local via `makeStopFilter` (§4.6) |
| `tools` | `toWireTools`: `{name, description, input_schema}` — já é o shape da wire; só garantir `input_schema` default `{type:"object",properties:{}}` |
| `tool_choice.type = "auto"` | nada |
| `tool_choice.type = "none"` | `params.tools = []` |
| `tool_choice.type = "any"` | instrução no system: *"Você DEVE chamar pelo menos uma das ferramentas disponíveis nesta resposta."* |
| `tool_choice.type = "tool"`, `name` | instrução no system nomeando a ferramenta |
| `tool_choice.disable_parallel_tool_use` | ignorar |
| `output_config.effort` | `params.reasoning_effort` se ∈ `low|medium|high|xhigh|max` |
| `thinking.type = "disabled"` | não mandar `reasoning_effort` |
| `thinking.type = "adaptive"/"enabled"` | sem efeito próprio (o effort vem de `output_config.effort` ou do sufixo do id) |
| sufixo de effort no id do modelo (`-max`, `-high`, …) | `resolveModel()` — **tem precedência** sobre `output_config.effort` (mesma regra do lado OpenAI) |
| `metadata`, `cache_control`, `service_tier`, `container`, `mcp_servers`, `fallbacks` | aceitos e ignorados |

`mode` da wire continua `"agent"`, `threadId` continua `randomUUID()` por request.

### 4.6 Alteração em `makeStopFilter`

Hoje devolve `{emit, hit: boolean}`. A Anthropic precisa saber **qual** sequência bateu, para
preencher `stop_sequence` na resposta.

Mudar para `{emit, hit: string|null}` (a string é a sequência que casou). No lado OpenAI o
`if (hit)` continua correto — string não-vazia é truthy e sequências vazias já são filtradas na
entrada. **Rodar a suite OpenAI depois dessa mudança.**

---

## 5. Resposta não-stream: wire → Anthropic

Shape alvo:

```json
{
  "id": "msg_<24 hex>",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "tool_use", "id": "toolu_...", "name": "get_weather", "input": { "city": "Paris" } }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 97,
    "output_tokens": 43,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

Regras:

- `id`: prefixo **`msg_`** (não `chatcmpl-`).
- `model`: o **id base** (sem sufixo de effort), igual ao que o lado OpenAI já faz.
- `content`: **ordem preservada** dos blocos como chegaram do stream. Texto e tool calls
  intercalados viram blocos na mesma ordem. `content` nunca é `null` — na pior hipótese `[]`.
- `tool_use.input` é **objeto JSON**, não string (diferença central em relação ao OpenAI, onde
  `function.arguments` é string). Se o `input` da wire vier string, tentar `JSON.parse`; falhando,
  usar `{}` — nunca mandar string.
- `tool_use.id`: usar `ev.toolCallId` da wire; se ausente, gerar `toolu_<hex>`.
- Blocos `thinking`: emitir **apenas** se o request trouxe `thinking` com `type` diferente de
  `"disabled"`. Formato `{"type":"thinking","thinking":"<texto>","signature":""}`. Ver limitação em §9.
- `stop_sequence`: a string que bateu, ou `null`.

`stop_reason` (mapa completo):

| Situação | `stop_reason` |
|---|---|
| houve ao menos um `tool_use` no content | `tool_use` |
| stop sequence cortou o texto | `stop_sequence` |
| wire `finishReason` ∈ `max_tokens`, `length` | `max_tokens` |
| qualquer outro | `end_turn` |

Precedência: `tool_use` > `stop_sequence` > `max_tokens` > `end_turn`.

`usage` (do evento `finish` da wire — campos confirmados em `PROTOCOLO.md`):

```
input_tokens                 <- totalUsage.inputTokens
output_tokens                <- totalUsage.outputTokens
cache_read_input_tokens      <- totalUsage.cachedInputTokens ?? totalUsage.inputTokenDetails.cacheReadTokens ?? 0
cache_creation_input_tokens  <- totalUsage.inputTokenDetails.cacheWriteTokens ?? 0
```

Sem evento `finish` (stream cortado): zerar tudo, não inventar.

---

## 6. Resposta stream: SSE Anthropic

Formato: cada evento é **duas linhas** — `event: <tipo>` e `data: <json>` — seguidas de linha em
branco. Diferente do OpenAI, que só usa `data:` e fecha com `[DONE]`. **A Anthropic não tem
`[DONE]`**; o fim é o evento `message_stop`.

Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`,
`Connection: keep-alive`, `X-Accel-Buffering: no`.

### 6.1 Sequência exata

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","model":"<id>","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Olá"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_x","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"Paris\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":97,"output_tokens":57}}

event: message_stop
data: {"type":"message_stop"}
```

### 6.2 Máquina de estado dos blocos

O ponto mais fácil de errar. A wire manda `text-delta` e `tool-call` em qualquer ordem; o
protocolo Anthropic exige que **um bloco seja fechado antes de o próximo abrir** e que os
`index` sejam sequenciais a partir de 0.

Estado: `openBlock = null | {kind:"text"|"tool_use"|"thinking", index}` e `nextIndex = 0`.

| Evento da wire | Ação |
|---|---|
| `text-delta` | se `openBlock.kind !== "text"` → fecha o aberto (`content_block_stop`) e abre `content_block_start` tipo `text`; emite `content_block_delta` com `text_delta` |
| `reasoning-delta` (só se thinking pedido) | idem, com bloco tipo `thinking` e delta `{"type":"thinking_delta","thinking":"..."}` |
| `tool-call` (com `providerExecuted !== true`) | fecha o bloco aberto; abre `content_block_start` tipo `tool_use` com `input:{}`; emite **um** `content_block_delta` com `input_json_delta` carregando o JSON inteiro em `partial_json`; emite `content_block_stop` imediatamente (a wire entrega o input completo de uma vez) |
| `tool-call` com `providerExecuted === true` | ignorar |
| `finish` | guardar `totalUsage` e `finishReason` |
| `error` | ver §7.3 |
| `abort` | tratar como `error` |

No fim do stream: fechar bloco aberto → `message_delta` → `message_stop`.

`partial_json` em um único delta é válido (o SDK só concatena os pedaços). Não fatiar.

### 6.3 `usage` no stream

A wire só entrega usage no `finish`, no fim; a API real manda `input_tokens` já no
`message_start`. Emitir `message_start` com `usage:{input_tokens:0,output_tokens:0}` e mandar o
usage completo no `message_delta`.

**Item de validação obrigatório:** confirmar com o SDK oficial que
`(await stream.finalMessage()).usage.input_tokens` sai com o valor real (o SDK sobrescreve com
o que vier em `message_delta.usage`). Se não sair, registrar como limitação conhecida no README
— **não** tentar segurar o stream para descobrir o input_tokens antes.

### 6.4 Stop sequences no stream

Ao `makeStopFilter` retornar `hit`: emitir o texto já filtrado, fechar o bloco, abortar o
upstream (`ac.abort()`), e emitir `message_delta` com `stop_reason:"stop_sequence"` e
`stop_sequence:<hit>`, seguido de `message_stop`. Mesma economia de crédito do lado OpenAI.

---

## 7. Erros

### 7.1 Refactor de `mapUpstreamError` → `classifyUpstreamError`

Hoje `mapUpstreamError` (`server.mjs:268`) devolve type/code OpenAI. Passa a devolver um **kind
neutro**, e cada dialeto traduz:

```js
export function classifyUpstreamError(status, message) // -> "rate_limit"|"auth"|"permission"|"not_found"|"invalid"|"upstream"
```

As regras de casamento por mensagem (`rate limit`, `usage window`, `insufficient credits`,
`model_not_in_plan`, `not recognized`, …) ficam **iguais** — só muda o valor retornado.

| kind | HTTP | OpenAI `error.type` / `error.code` | Anthropic `error.type` |
|---|---|---|---|
| `rate_limit` | 429 | `rate_limit_exceeded` / `rate_limit_exceeded` | `rate_limit_error` |
| `auth` | 401 | `invalid_request_error` / `invalid_api_key` | `authentication_error` |
| `permission` | 403 | `invalid_request_error` / `permission_denied` | `permission_error` |
| `not_found` | 404 | `invalid_request_error` / `model_not_found` | `not_found_error` |
| `invalid` | status do upstream (4xx) | `invalid_request_error` / `null` | `invalid_request_error` |
| `upstream` | 502 | `upstream_error` / `null` | `api_error` |

A suite OpenAI já cobre os três primeiros — se ela quebrar no refactor, o mapeamento saiu errado.

### 7.2 Shape de erro Anthropic

```json
{
  "type": "error",
  "error": { "type": "invalid_request_error", "message": "max_tokens: field required" },
  "request_id": "req_<hex>"
}
```

`request_id` é opcional na spec; gerar um por request ajuda a correlacionar com o log.

### 7.3 Erro no meio do stream

A Anthropic sinaliza com um evento `error` e **encerra sem `message_stop`**:

```
event: error
data: {"type":"error","error":{"type":"rate_limit_error","message":"usage window limit reached"}}
```

Nunca emitir `message_delta`/`message_stop` depois de um erro — isso faz o SDK tratar como
sucesso truncado (é exatamente o bug que já foi corrigido no lado OpenAI).

---

## 8. `POST /v1/messages/count_tokens`

A wire do commandcode **não tem** endpoint de contagem. Devolver 404 quebra harnesses que usam
count_tokens para decidir compactação, e chamar o upstream com `max_tokens:1` gastaria crédito.

Implementar **estimativa local**, documentada como aproximação:

```js
// ponytail: estimativa por caracteres; a wire não expõe tokenizer.
// Troca por contagem real se o upstream algum dia publicar um endpoint.
const chars = JSON.stringify([system, messages, tools]).length;
return { input_tokens: Math.ceil(chars / 4) };
```

Resposta: `{"input_tokens": N}` (só esse campo). Validação: mesmo `messages` obrigatório do
`/v1/messages`; `max_tokens` **não** é obrigatório aqui.

README deve dizer, em uma linha, que o número é estimado (±25%) e não serve para billing.

---

## 9. Limitações a documentar (não são bugs)

| Item | Comportamento |
|---|---|
| `cache_control` / prompt caching | aceito e ignorado; `cache_creation_input_tokens` reflete o cache do upstream, não um cache do proxy |
| blocos `thinking` no request | descartados (a wire não aceita replay de reasoning) |
| `signature` dos blocos `thinking` na resposta | string vazia — não é assinatura válida da Anthropic; serve só para leitura, não para replay |
| `top_k` | ignorado |
| `document` (PDF) | 400 |
| `/v1/complete`, batches, files, Managed Agents | não implementados |
| `count_tokens` | estimativa local |
| `anthropic-version` | aceito com qualquer valor, inclusive ausente |
| auth | o proxy **não valida** `x-api-key` (igual ao lado OpenAI); a key real é a do commandcode |

---

## 10. Fases de implementação

Cada fase termina com a suite verde. Não pular a fase 1.

| Fase | Entrega | Critério de saída |
|---|---|---|
| **1. Refactor** | `upstream.mjs` + `openai.mjs` extraídos; `classifyUpstreamError`; `makeStopFilter` devolvendo a string | `npm test` 61/61, sem mudança de comportamento observável |
| **2. Roteamento** | `server.mjs` com prefixos e desambiguação de `/v1/models` (§3.2) | `/openai/v1/chat/completions` e `/v1/chat/completions` respondem igual |
| **3. Conversão de entrada** | `toWireFromAnthropic(body)` + validação local (§4) | testes de mock que inspecionam `lastUpstreamBody` passam |
| **4. Não-stream** | `POST /v1/messages` sem stream (§5) | shape e `stop_reason` corretos nos testes de mock |
| **5. Stream** | SSE completo com máquina de estado de blocos (§6) | ordem de eventos e índices corretos; SDK oficial monta a mensagem |
| **6. Erros** | mapeamento §7 + erro mid-stream | SDK oficial lança `RateLimitError`/`APIError` |
| **7. Models + count_tokens** | `/v1/models`, `/v1/models/{id}`, `/v1/messages/count_tokens` | shapes conferidos |
| **8. Docs** | `cc-proxy/README.md` com seção Anthropic + tabela de cobertura; `README.md` raiz | — |

---

## 11. Testes e validação

### 11.1 Infra

Reusar o padrão que já existe em `cc-proxy/test.mjs`: mock upstream in-process (cenário
escolhido pelo nome do modelo), `lastUpstreamBody` para inspecionar o que foi enviado, e um
segundo proxy apontando para o mock. Manter **um** `test.mjs` com flags:

```
node test.mjs              # tudo (mock + real, os dois dialetos)
node test.mjs --mock       # só conformidade, sem custo
node test.mjs --anthropic  # só o dialeto Anthropic
node test.mjs --openai     # só o dialeto OpenAI
```

`package.json`: `"test:mock"` já existe; acrescentar `"test:anthropic": "node test.mjs --anthropic"`.

Cenários novos a acrescentar no mock (além dos que já existem): um que emite
`text-delta → tool-call → text-delta` (para provar a máquina de estado dos blocos) e um que
emite `reasoning-delta` antes do texto.

### 11.2 Conformidade (mock — sem custo)

Request / conversão (inspecionando `lastUpstreamBody`):

1. `max_tokens` ausente → 400 `invalid_request_error`, `error.type` correto.
2. `messages` vazio → 400. `model` ausente → 400. Body não-JSON → 400.
3. `system` string → `params.system` igual.
4. `system` array de blocos → blocos juntados com `\n\n`.
5. **sem `system` → `params.system` é o `DEFAULT_SYSTEM`** (regressão cara: sem isso volta o prompt de 7.6k tokens).
6. `config` enviada é neutra (`workingDir === "/"`, `structure: []`).
7. `tools` Anthropic → `params.tools` com `{name, description, input_schema}` sem alteração.
8. `tool_choice:{type:"none"}` → `params.tools === []`.
9. `tool_choice:{type:"tool",name:"x"}` → instrução nomeando `x` no system.
10. user message com `tool_result` → mensagem wire `role:"tool"` com `toolCallId`/`toolName` corretos.
11. user message com `tool_result` **+** `text` → duas mensagens wire, `tool` antes de `user`.
12. `tool_result.is_error: true` → value prefixado com `"Error: "`.
13. assistant com bloco `thinking` → descartado, resto preservado.
14. imagem base64 → `{type:"image",image:"data:...",mimeType}`.
15. `output_config.effort:"high"` → `params.reasoning_effort === "high"`.
16. modelo com sufixo `-max` + `output_config.effort:"low"` → vence o sufixo (`"max"`).

Resposta não-stream:

17. shape: `id` começa com `msg_`, `type:"message"`, `role:"assistant"`, `content` array, `stop_reason`, `stop_sequence`, `usage`.
18. `content[0].type === "text"` com o texto do stream.
19. tool call → bloco `tool_use` com `input` **objeto** (`typeof input === "object"`), `stop_reason:"tool_use"`.
20. cenário `provider-executed` → **nenhum** bloco `tool_use` no content.
21. cenário `no-trailing-newline` → `usage.input_tokens === 10` (não pode zerar).
22. cenário `max-tokens` → `stop_reason:"max_tokens"`.
23. cenário `reasoning` **sem** `thinking` no request → nenhum bloco `thinking`; **com** `thinking:{type:"adaptive"}` → bloco `thinking` presente.
24. `usage.cache_read_input_tokens` vem do `cachedInputTokens`/`inputTokenDetails`.
25. `stop_sequences:["fau"]` no cenário default (texto `"default"`) → content `"de"`, `stop_reason:"stop_sequence"`, `stop_sequence:"fau"`.

Stream:

26. primeiro evento é `message_start` com `message.type === "message"` e `content: []`.
27. ordem: `content_block_start` → ≥1 `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`.
28. **não** existe `data: [DONE]` em lugar nenhum.
29. cenário texto→tool→texto: três blocos, `index` 0,1,2, cada `content_block_start` precedido do `content_block_stop` do anterior.
30. bloco `tool_use`: `content_block_start` traz `id`/`name` e `input:{}`; o delta é `input_json_delta` com `partial_json` parseável.
31. `message_delta.delta.stop_reason` correto e `message_delta.usage.output_tokens > 0`.
32. erro mid-stream → evento `error` presente, **sem** `message_stop` depois.
33. stop sequence no stream → `stop_reason:"stop_sequence"` + `stop_sequence` preenchido.

Erros e rotas:

34. upstream 429 → HTTP 429, `error.type:"rate_limit_error"`.
35. upstream 401 → HTTP 401, `authentication_error`.
36. upstream `model_not_in_plan` → HTTP 404, `not_found_error`.
37. `GET /v1/models` com header `x-api-key` → shape Anthropic (`data[].type === "model"`, `display_name`, `created_at` ISO 8601, `has_more:false`).
38. `GET /v1/models` **sem** header Anthropic → shape OpenAI (`object:"list"`, `data[].object === "model"`).
39. `GET /anthropic/v1/models` → shape Anthropic mesmo sem header.
40. `GET /openai/v1/models` → shape OpenAI mesmo **com** header `x-api-key`.
41. `GET /v1/models/{id}` inexistente → 404 `not_found_error`.
42. `POST /v1/messages/count_tokens` → `{input_tokens:N}` com `N > 0`; sem `messages` → 400.
43. cliente desconecta durante o stream → mock registra o fechamento da conexão upstream.
44. **regressão OpenAI**: a suite inteira do dialeto OpenAI continua verde.

### 11.3 Testes reais (consomem crédito — janela do plano Go)

Contra `api.commandcode.ai`, modelo `deepseek/deepseek-v4-flash`:

45. mensagem simples → `content[0].text` não vazio, `stop_reason:"end_turn"`.
46. **`usage.input_tokens < 1000`** — prova que o system default está sendo aplicado (sem ele, ~7.6k).
47. stream → texto acumulado não vazio, `message_stop` recebido.
48. tool use: modelo emite `tool_use`; devolver `tool_result` numa mensagem `user` e obter resposta final coerente.
49. `system` respeitado (responder em português).
50. `stop_sequences` real → texto cortado, `stop_reason:"stop_sequence"`.
51. modelo inexistente → 404 `not_found_error`.
52. variante `-max` → 200, `model` na resposta é o id base.

### 11.4 Validação com o SDK oficial

`@anthropic-ai/sdk` como `devDependency`. Este é o teste que pega desvio de contrato que os
testes por `fetch` não pegam.

```js
import Anthropic from "@anthropic-ai/sdk";
const c = new Anthropic({ baseURL: "http://127.0.0.1:8787/anthropic", apiKey: "x", maxRetries: 0 });

// A) não-stream
const m = await c.messages.create({ model: M, max_tokens: 256, messages: [{ role: "user", content: "diga: ok" }] });

// B) stream + finalMessage (valida a montagem dos blocos e do usage)
const s = c.messages.stream({ model: M, max_tokens: 256, messages: [{ role: "user", content: "conte 1 2 3" }] });
for await (const ev of s) { /* consumir */ }
const final = await s.finalMessage();   // usage.input_tokens deve ser > 0 (ver §6.3)

// C) round-trip de tool
const r1 = await c.messages.create({ model: M, max_tokens: 512, tools: [tool],
  messages: [{ role: "user", content: "Use get_weather para Paris." }] });
const tu = r1.content.find((b) => b.type === "tool_use");
const r2 = await c.messages.create({ model: M, max_tokens: 512, tools: [tool], messages: [
  { role: "user", content: "Use get_weather para Paris." },
  { role: "assistant", content: r1.content },
  { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "18°C, sol" }] },
]});

// D) erros tipados
try { await c.messages.create({ model: "zzz/nao-existe", max_tokens: 16, messages: [{ role: "user", content: "x" }] }); }
catch (e) { /* Anthropic.NotFoundError, e.status === 404 */ }
// contra o mock: cenário http-429 deve dar Anthropic.RateLimitError; mid-error em stream deve lançar
```

Checar: `r1.content` volta do SDK sem erro de validação, `tu.input` é objeto, `final.usage`
preenchido, e o erro mid-stream **lança** em vez de terminar quieto.

---

## 12. Critérios de aceite

- [ ] `npm test` verde: 61/61 do OpenAI **sem regressão** + os casos novos do Anthropic.
- [ ] `npm run test:mock` roda sem tocar em `api.commandcode.ai`.
- [ ] SDK `@anthropic-ai/sdk` funciona com `baseURL` apontando pro proxy: create, stream +
      `finalMessage()`, round-trip de tool, erros tipados.
- [ ] SDK `openai` continua funcionando igual.
- [ ] `usage.input_tokens` de uma pergunta curta fica < 1000 (system default aplicado).
- [ ] Erro no meio do stream lança nos dois SDKs.
- [ ] Cliente que desconecta cancela a geração upstream nos dois dialetos.
- [ ] Proxy continua **sem dependências de runtime** e escutando em `127.0.0.1`.
- [ ] `cc-proxy/README.md` com tabela de cobertura do contrato Anthropic, tabela de rotas e as
      limitações do §9.

---

## 13. Armadilhas (checklist de revisão)

1. `tool_use.input` é **objeto**; `function.arguments` do OpenAI é **string**. Não copiar o código do outro dialeto sem trocar isso.
2. `tool_result` vem em mensagem **`user`**, não numa role própria — e vira `role:"tool"` na wire.
3. Anthropic **não tem `[DONE]`**. Quem terminar o stream com `[DONE]` deixa o SDK pendurado.
4. `content_block_stop` antes de cada novo `content_block_start`. Índices sequenciais a partir de 0.
5. SSE Anthropic usa `event:` **e** `data:`. O OpenAI usa só `data:`.
6. `max_tokens` é obrigatório na Anthropic (no OpenAI é opcional) — validar localmente.
7. Não emitir `message_stop` depois de um evento `error`.
8. `params.system` sempre preenchido, nos **dois** dialetos.
9. `providerExecuted: true` nunca vira bloco `tool_use`.
10. Prefixo do id: `msg_` no Anthropic, `chatcmpl-` no OpenAI.
11. Ao alterar `makeStopFilter`, rodar a suite OpenAI antes de seguir.
12. `stop_reason:"stop_sequence"` exige preencher também o campo `stop_sequence`.

---

## 14. Referências

- `PROTOCOLO.md` — wire do commandcode (eventos NDJSON, campos de usage, `providerExecuted`, o
  system prompt implícito).
- `cc-proxy/server.mjs` — implementação OpenAI atual, que é o modelo a seguir.
- `cc-proxy/test.mjs` — padrão de teste (mock in-process + reais).
- Messages API: `https://docs.claude.com/en/api/messages`
- Streaming: `https://docs.claude.com/en/docs/build-with-claude/streaming`
- Erros: `https://docs.claude.com/en/api/errors`
- Count tokens: `https://docs.claude.com/en/docs/build-with-claude/token-counting`
