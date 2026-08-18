# Refinamento — compatibilidade plena do cc-proxy com Claude Code (DeepSeek)

Comparação criteriosa entre `routatic-proxy` (Go, referência de compatibilidade) e
`cc-proxy` (este projeto, TS). Foco 100% em **DeepSeek flash/pro** via Claude Code.

O routatic-proxy fala a Messages API nativamente para DeepSeek e faz **passthrough do
body original**, só aplicando fixups. O cc-proxy converte para a wire do commandcode
(`/alpha/generate`), que é outro padrão — então parte da conversa é diferente por
natureza. Mas a compatibilidade com o Claude Code depende de um conjunto pequeno e
específico de detalhes. Estes são os que faltam, por ordem de impacto.

---

## 1. CRÍTICO — Round-trip de reasoning no request (multi-turn quebra)

**Problema.** O `toWireMessages` do dialeto Anthropic **descarta** os blocos `thinking`
e `redacted_thinking` do histórico:

```ts
// anthropic.ts:150-151
// thinking / redacted_thinking: descartados (a wire não aceita replay de reasoning)
```

Isso é o exato oposto do que o routatic-proxy faz para DeepSeek. DeepSeek roda em
thinking mode por padrão e exige que o reasoning de uma mensagem `assistant` seja
passado de volta na próxima chamada — e que todo turno de `assistant` que chamou uma
ferramenta traga o reasoning correspondente. Sem isso, o histórico passa a ser
rejeitado a partir da primeira tool call (no routatic isso se manifestava como 400
bare, e era o que matava conversa após compaction).

O routatic-proxy trata em três pontos:

1. **`EnsureThinkingBlocks`** (`internal/transformer/anthropic_wire.go:85`) — injeta um
   bloco `{"type":"thinking","thinking":""}` (vazio, sem assinatura) em toda mensagem
   `assistant` que tem `tool_use` mas não tem `thinking`. O upstream aceita o bloco
   vazio.
2. **`normalize.go:68-79`** — preserva `block.Thinking` anexado diretamente ao bloco
   `tool_use` (o Claude Code faz isso quando o turno termina em tool call).
3. **`normalize.go:96-102`** — `redacted_thinking` vira placeholder `" "` para que a
   guarda de continuidade do thinking mode ainda veja o turno como "pensou".

**O wire do commandcode aceita reasoning.** O `PROTOCOLO.md` documenta o tipo
`{type:"reasoning",text}` em conteúdo de `assistant`. Ou seja: não é que a wire não
aceita replay — é o proxy que joga fora.

**O que fazer no cc-proxy:**

- No `toWireMessages` (anthropic.ts), mapear `thinking` → `{type:"reasoning", text}`
  em vez de descartar. Idem `redacted_thinking` → `reasoning` com texto placeholder
  (`" "`).
- Espelhar `EnsureThinkingBlocks`: se uma mensagem `assistant` tem `tool-call` mas não
  tem reasoning, injetar `{type:"reasoning", text:""}`.
- Adicionar teste de round-trip **com** thinking (o teste atual em `test.mjs:352`
  asserta o comportamento errado: `"assistant: thinking descartado"`).

> Ponto de atenção: validar empiricamente se o upstream commandcode (provider `cai`)
> de fato rejeita reasoning ausente como o OpenCode Go faz. Se não rejeitar, a injeção
> vira no-op inofensivo. Se rejeitar, é a diferença entre conversa de 1 turno e
> conversa que sobrevive ao primeiro tool call.

---

## 2. CRÍTICO — Re-chunking do reasoning na saída

**Problema.** O upstream do routatic (OpenCode Go) entrega o reasoning do DeepSeek
**num bloco só** (um `content_block_start` preenchido, ou um único `thinking_delta`
gigante). O Claude Code renderiza delta a delta — então um bloco que chega inteiro
aparece inteiro, depois de uma tela congelada.

O routatic resolve com `ThinkingRechunker` (`internal/transformer/thinking_rechunk.go`):
fatiar o `thinking` em deltas de **48 runes** espaçados por **80ms**, preservando
`index` e `signature`. O texto vai aparecendo progressivamente em vez de saltar de uma
vez.

**O cc-proxy não faz isso.** O handler só repassa `reasoning-delta` como chega
(anthropic.ts:404-410). Se a wire do commandcode também bufferizar o reasoning e
entregar num único `reasoning-delta` grande, o efeito é o mesmo congelamento.

**O que fazer no cc-proxy:**

- Medir primeiro: um request `deepseek-v4-flash` com `thinking` ligado entrega o
  reasoning em um `reasoning-delta` só ou em vários?
- Se vier em um bloco só, aplicar o mesmo re-chunk na saída do `appendText("thinking",
  ...)` — fatiar em pedaços pequenos, emitir um `thinking_delta` por pedaço, com um
  pequeno delay entre eles (mesmo budget de pacing de ~3s do routatic).

---

## 3. ALTO — `count_tokens` com tokenizer real + estimativa de imagem

**Problema.** O cc-proxy conta por caractere:

```ts
// anthropic.ts:233
const chars = JSON.stringify([body.system ?? "", messages, body.tools ?? []]).length;
json(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)) });
```

Dois defeitos:

1. **Precisão ±25%.** O Claude Code usa `count_tokens` para decisão de budget de
   contexto e auto-compact. Num contexto de 1M, ±25% significa compactar dezenas de
   milhares de tokens cedo ou tarde demais.
2. **Imagem estoura a conta.** `JSON.stringify(messages)` inclui o base64 da imagem.
   Um screenshot de 1 MB vira ~1,3M chars ÷ 4 ≈ **333k tokens**, quando o custo real é
   ~1.500-4.000. O Claude Code veria um "contexto" absurdamente inflado em todo request
   com imagem e compactaria sem necessidade.

O routatic usa **tiktoken `cl100k_base`** (`internal/token/counter.go`) e uma
**estimativa de imagem** por tamanho do base64 (`internal/handlers/token_count.go:84-117`,
~`rawBytes/75`, clamp 300-4000; URL sem dados → 1500 default).

**O que fazer no cc-proxy:**

- Trocar char/4 por um tokenizer real. Em Node, `gpt-tokenizer` (ou `js-tiktoken`) com
  `cl100k_base` é a dependência certa (o `@anthropic-ai/sdk` já usa por baixo dos
  panos; dá pra reutilizar a contagem dele em vez de adicionar lib). Para DeepSeek o
  `cl100k` é aproximado, mas ordens de grandeza melhor que char/4.
- Contar imagens separadamente com a heurística do routatic (nunca `/4` sobre o
  base64).

---

## 4. ALTO — Keepalive `event: ping` no stream

**Problema.** O routatic emite `event: ping\ndata: {"type":"ping"}` a cada **3s**
enquanto o stream está vivo (`internal/handlers/messages.go:266-341`), o mesmo
heartbeat que a Messages API real manda. Serve para atravessar proxies/timeouts de
camada de rede e manter o stream aberto durante pausas longas de reasoning.

O cc-proxy não emite nenhum ping. Num reasoning longo do DeepSeek (que pode ficar
muitos segundos sem emitir texto), a conexão pode ser morta por idle de algum
intermediário ou do próprio harness.

**O que fazer no cc-proxy:**

- No caminho stream (anthropic.ts), após `sseHead`, disparar um `setInterval` de ~3s
  que escreve `event: ping\ndata: {"type":"ping"}\n\n` **apenas se não houve escrita
  desde o último tick** (não intercalar ping no meio de um frame). Limpar o interval
  no `message_stop`/`error`/`close`.

---

## 5. MÉDIO — Mapeamento de erro completo (`overloaded_error`, `Retry-After`)

**Problema.** O `ERROR_MAP` do dialeto Anthropic (anthropic.ts:58-65) não tem
`overloaded` e o `classifyUpstreamError` (upstream.ts:204-215) trata qualquer status
≥500 como `upstream` → `api_error`. O routatic mapeia:

```
529/503 → overloaded_error
429     → rate_limit_error  (+ header Retry-After: 30)
```

(`internal/transformer/response.go:154-173`, e `Retry-After` em
`internal/handlers/messages.go:400-405` e `1045-1048`.)

O Claude Code tem política de retry/backoff distinta por tipo de erro: `overloaded_error`
(529) e `rate_limit_error` (429) disparam backoff e re-tentativa; `api_error` genérico
não. Sem `overloaded_error`, um 503 do upstream vira falha dura onde deveria re-tentar.

**O que fazer no cc-proxy:**

- Adicionar `overloaded` ao `ErrorKind` e mapear 529/503 → `overloaded_error` no
  `ERROR_MAP` do Anthropic.
- Em 429, mandar header `Retry-After: 30` (tanto no path HTTP quanto no evento `error`
  do stream).

---

## 6. MÉDIO — Campos de effort que o Claude Code pode mandar

**Problema.** O cc-proxy lê só `output_config.effort` e `thinking.budget_tokens`
(anthropic.ts:263-271). O routatic lê todas as grafias que o Claude Code e outros
clientes já usaram (`internal/core/normalize.go:147-188`):

```
output_config.effort  →  reasoning_effort  →  reasoning.effort  →  effort  →  level  →  depth
```

O `output_config.effort` (Claude Code 2.x) é o principal e **já está coberto**. Mas
`reasoning.effort`, `level` e `depth` são grafias que aparecem em builds/harnesses
diferentes e hoje são silenciosamente ignoradas (o request cai no effort default).

**O que fazer no cc-proxy:**

- Estender `cfgEffort` para tentar, em ordem: `output_config.effort` →
  `reasoning.effort` → `effort` → `level` → `depth` (mapear depth 1→low, 2→medium,
  3→high, ≥4→max) → `thinking.budget_tokens` por faixa.

> Nota: a normalização `low|medium|high|xhigh|max` do routatic **colapsa** para
> `low|high|max` (`normalizeDeepSeekEffort`, `request.go:311`) porque o OpenCode Go só
> entende 3 níveis. A wire do commandcode aceita os 5 — o cc-proxy está certo em
> repassar direto. Não copiar o colapso; copiar só a leitura das grafias.

---

## 7. MÉDIO — Idle watchdog por byte (não só timeout global)

**Problema.** O cc-proxy tem um único `AbortSignal.timeout(10min)`
(upstream.ts:18) + abort em `res.on("close")`. Não detecta stream **pendurado** — uma
conexão que parou de emitir mas não fechou só é derrubada aos 10 min.

O routatic usa idle watchdog **por leitura**: cada byte que chega renova um deadline;
se nenhum byte chegar por `idle_timeout`, cancela o upstream e (no caso do routatic,
que tem fallback) tenta o próximo modelo. Para o cc-proxy não há fallback, mas a
detecção de travamento ainda evita pendurar a request do Claude Code por 10 min.

**O que fazer no cc-proxy:**

- No loop de `readEvents`, rastrear o timestamp da última linha emitida e abortar o
  `AbortController` se o gap passar de um idle timeout configurável (ex. 60s). É um
  `setInterval`/comparação simples, sem reescrever o parser.

---

## 8. VERIFICAR — `input_tokens` e cache no `message_delta`

**Ponto de atenção, não bug confirmado.** O routatic subtrai cache do prompt:

```
input_tokens = prompt_tokens - cache_read - cache_write
```

(`internal/transformer/response.go:58-72` e `stream.go:836-855`.) O motivo: na
Messages API, `input_tokens` é o total de tokens **não-cache** do turno; se o proxy
reportar o prompt total, o gauge de contexto do Claude Code vê um input inflado a cada
turno e dispara auto-compact ~5x cedo demais.

O cc-proxy mapeia `input_tokens = u.inputTokens ?? 0` direto da wire. O `PROTOCOLO.md`
sugere que o `inputTokens` do commandcode **já é** o não-cache (exemplo medido: 97
tokens para prompt de 5 palavras, com o prompt de agente injetado vindo do cache em
`cacheReadTokens`). Se isso se confirmar, o mapeamento atual está correto.

**O que fazer no cc-proxy:**

- Conferir num request real multi-turn: o `inputTokens` do `finish` cresce junto com o
  tamanho total do histórico (sinal de que inclui cache → precisa subtrair) ou fica
  pequeno e estável (já é não-cache → ok)?
- Se incluir cache, aplicar a mesma subtração do routatic no `usageOf`.

> O `message_start` do cc-proxy **já** sai com usage zerado e o valor real no
> `message_delta` — isso é o comportamento correto (o mesmo que o routatic aprendeu a
> fazer em `stream.go:197-209`). Manter.

---

## 9. MENOR — `display_name` no `GET /v1/models`

O routatic documenta que o Claude Code, ao descobrir modelos via gateway
(`GET /v1/models?limit=1000`), lê `display_name` mas **só exibe ids começando com
`claude`/`anthropic`** (`internal/handlers/models.go:25-31`).

O cc-proxy já devolve `display_name` (anthropic.ts:81). Sem impacto prático para
DeepSeek, já que o Claude Code usa o model string configurado e não o picker. Deixar
como está; só não remover o campo.

---

## Resumo de prioridade

| # | Item | Impacto | Arquivo(s) no cc-proxy |
|---|------|---------|------------------------|
| 1 | Preservar/injetar reasoning no request | quebra multi-turn | `anthropic.ts` (toWireMessages) |
| 2 | Re-chunk do reasoning na saída | tela congelada | `anthropic.ts` (handleStream) |
| 3 | count_tokens real + imagem | auto-compact errado | `anthropic.ts:225` |
| 4 | Keepalive ping 3s | stream cai em reasoning longo | `anthropic.ts` (stream) |
| 5 | overloaded_error 529 + Retry-After | retry não acontece | `anthropic.ts`, `upstream.ts` |
| 6 | Grafias extras de effort (level/depth/…) | effort default errado | `anthropic.ts:263` |
| 7 | Idle watchdog por byte | request pendura 10min | `anthropic.ts` (stream) |
| 8 | input_tokens vs cache | auto-compact (verificar) | `anthropic.ts` (usageOf) |
| 9 | display_name | nenhum (manter) | — |

Os itens 1 e 2 são os que explicam a sensação de "funciona mas não está 100%":
multi-turn com tool que morre depois do primeiro call, e reasoning que aparece de uma
vez. Comece por eles.
