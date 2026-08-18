# Refinamento do cc-proxy para Claude Code + DeepSeek

Reavaliação completa do `cc-proxy` contra o `routatic-proxy`, com foco exclusivo nos
modelos `deepseek/deepseek-v4-flash` e `deepseek/deepseek-v4-pro` via Messages API do
Claude Code.

## Como a reavaliação foi feita

Foram comparados os caminhos de request, stream, tool use, usage, erros, tokenização e
cancelamento dos dois projetos. Além da leitura de código, o contrato do
`POST /alpha/generate` foi medido diretamente contra a API real do commandcode:

- reasoning `max` no flash chegou em 32 `reasoning-delta` pequenos, não em um bloco;
- flash e pro aceitaram históricos com tool calls sem reasoning;
- o commandcode emite `tool-input-start`, muitos `tool-input-delta`,
  `tool-input-end` e só depois o `tool-call` final;
- tools paralelas têm deltas intercalados;
- em cache hit real, o usage foi `inputTokens=4894`,
  `noCacheTokens=30`, `cacheReadTokens=4864`;
- a primeira linha NDJSON chegou junto dos headers em aproximadamente 1,2 s;
- imagens foram aceitas pelos dois modelos DeepSeek;
- `inputTokens` cresce com o histórico e representa o prompt total.

Essas medições corrigem premissas importantes da versão anterior deste documento.

## Correções da avaliação anterior

### Reasoning ausente não quebrava multi-turn no commandcode

A avaliação anterior marcou como crítico injetar reasoning em todo turno de tool e
afirmou que a conversa quebraria após a primeira chamada. Isso é verdade para o wire
DeepSeek/OpenCode usado pelo routatic, mas não para o adaptador do commandcode.

Testes reais com flash e pro, inclusive histórico com duas tool calls sem reasoning,
foram aceitos. O commandcode monta internamente `providerOptions.reasoning_content` e
não impõe a mesma validação do OpenCode Go.

Preservar `thinking` continua sendo útil para manter a informação do modelo e
compatibilidade de round-trip, mas não é o fator crítico que a versão anterior
descrevia. O proxy mantém essa preservação e o placeholder como defesa compatível.

### Re-chunk de reasoning raramente é necessário aqui

O OpenCode Go usado pelo routatic pode entregar reasoning inteiro em um único frame.
O commandcode medido entrega muitos deltas pequenos. Portanto, re-chunk não explica
travamentos normais deste proxy.

O fallback para deltas excepcionalmente grandes foi mantido, mas agora tem o mesmo
budget total de pacing de 3 s do routatic. A implementação anterior não aplicou esse
limite: um bloco muito grande poderia bloquear a leitura do upstream por vários
segundos.

### `inputTokens` não é a parcela sem cache

Esta era a falha mais grave não confirmada pela avaliação anterior. A medição real
mostrou:

```text
inputTokens      = 4894  (prompt total)
noCacheTokens    = 30
cacheReadTokens  = 4864
```

Publicar `input_tokens=4894` e `cache_read_input_tokens=4864` fazia o Claude Code
contar quase todo o contexto duas vezes. O efeito é gauge de contexto inflado,
auto-compaction precoce e telemetria incorreta.

O mapeamento correto agora é:

```text
input_tokens                = inputTokenDetails.noCacheTokens
cache_read_input_tokens     = cachedInputTokens || cacheReadTokens
cache_creation_input_tokens = cacheWriteTokens
```

Quando `noCacheTokens` não existir, o proxy usa
`max(0, inputTokens - cacheRead - cacheWrite)`.

### O tokenizer importado não era `cl100k_base`

`gpt-tokenizer` 4 exporta `o200k_base` na raiz. A implementação anterior dizia usar
`cl100k_base`, mas importava `encode` do pacote raiz. O import agora é explicitamente:

```ts
gpt-tokenizer/encoding/cl100k_base
```

Também foi acrescentado overhead de framing por mensagem, como no contador do
routatic. Continua sendo estimativa: não existe tokenizer DeepSeek oficial exposto
pelo commandcode.

## Ajustes implementados nesta reavaliação

### 1. Streaming incremental de argumentos de tools

Antes, o proxy ignorava `tool-input-start/delta/end` e esperava o `tool-call` final.
Uma tool com argumento grande, como escrita de arquivo, só aparecia no Claude Code
depois de toda a geração.

Agora:

- tools declaradas pelo cliente abrem um `content_block_start` imediatamente;
- cada `tool-input-delta` vira `input_json_delta`;
- `tool-input-end` fecha o bloco;
- o `tool-call` final atualiza o conteúdo acumulado sem duplicar o bloco;
- deltas intercalados de tools paralelas são serializados em blocos Anthropic
  sequenciais e com índices contíguos;
- tools executadas pelo provider não são antecipadas, evitando vazar
  `providerExecuted:true` como tool do cliente.

Este era o principal detalhe de streaming ausente em relação à experiência do Claude
Code.

### 2. Usage de cache sem dupla contagem

Adicionado suporte a `inputTokenDetails.noCacheTokens` e corrigido o mapeamento
Anthropic descrito acima. Coberto por teste com os números da medição real.

### 3. Reasoning inline em `tool_use`

O Claude Code pode anexar `thinking` diretamente ao bloco `tool_use`, em vez de criar
um bloco `thinking` separado. O routatic já trata esse formato.

O cc-proxy agora converte esse campo em `reasoning` e o posiciona antes da tool. Quando
o turno tem tool sem reasoning, o placeholder também é inserido no começo da mensagem,
preservando a ordem `reasoning → text/tool`.

### 4. Respostas vazias bem-formadas

Se todo o budget for consumido pelo reasoning suprimido, ou se só houver uma tool
server-side, o upstream pode terminar sem conteúdo visível.

O proxy agora garante:

- não-stream: `content: [{type:"text", text:""}]`;
- stream: `content_block_start` + `content_block_stop` de texto vazio antes do
  `message_delta`.

Sem isso, Claude Code/SDK pode interpretar o sucesso como resposta truncada.

### 5. Imagens retornadas por tools

Imagens dentro de `tool_result.content` eram descartadas. Agora o resultado textual
continua como mensagem `tool` e a evidência visual é preservada numa mensagem `user`
imediatamente posterior. Se o resultado tiver só imagem, o texto da tool recebe
`[Image returned by tool]`.

Isso importa para screenshots e ferramentas visuais usadas pelo Claude Code.

### 6. Todas as grafias de effort

Foi acrescentada a grafia top-level `reasoning_effort`, que a implementação anterior
ainda havia esquecido. A precedência atual é:

```text
sufixo do model id
  > output_config.effort
  > reasoning_effort
  > reasoning.effort
  > effort
  > level
  > depth
  > thinking.budget_tokens
```

O commandcode aceita `low`, `medium`, `high`, `xhigh` e `max`; não é aplicado o
colapso de níveis necessário no OpenCode Go.

### 7. Pacing de reasoning limitado

O re-chunk de frames anormalmente grandes continua em 48 runes e 80 ms, mas o sono
total por stream foi limitado a 3 s. Depois disso, os chunks restantes são emitidos
sem atraso.

### 8. Corrupção persistente de NDJSON deixa de ser silenciosa

O parser descartava qualquer linha inválida sem aviso, podendo transformar stream
corrompido em resposta parcial de sucesso. Agora tolera até três falhas consecutivas e
depois encerra com erro; uma última linha inválida também falha explicitamente.

### 9. Exceções assíncronas não derrubam o processo

O callback HTTP assíncrono não tinha barreira para promises rejeitadas. Uma exceção
fora dos catches locais podia virar rejection não tratada e encerrar o Node.

O servidor agora captura a falha no topo, devolve erro no dialeto correto quando os
headers ainda não foram enviados e destrói somente a conexão quando o stream já
começou.

## Pontos da implementação anterior confirmados e mantidos

- keepalive Anthropic `event: ping` em cadência fixa de 3 s;
- idle watchdog renovado por chunks do upstream;
- cancelamento upstream quando o cliente desconecta;
- headers SSE só são confirmados depois de o upstream responder com HTTP 2xx;
- `overloaded_error` para 503/529;
- `rate_limit_error` e `Retry-After: 30` para 429 antes do stream;
- erro no meio do stream termina sem `message_stop`;
- `message_start` com usage zerado e usage autoritativo no `message_delta`;
- preservação de `thinking` e `redacted_thinking`;
- `count_tokens` com base64 de imagem contado separadamente;
- stop sequences aplicadas no proxy;
- índices de content blocks contíguos;
- tool call final com `input` objeto;
- filtro de tools `providerExecuted`.

## Limitações residuais do wire commandcode

Estas limitações não têm correção fiel apenas no proxy:

| Item | Estado |
|---|---|
| assinatura de thinking | commandcode não fornece assinatura replayable; resposta usa `signature:""` |
| `tool_choice any/tool` | wire não expõe controle equivalente; vira instrução no system |
| `count_tokens` | estimativa `cl100k_base` + overhead + heurística de imagem, não billing exato |
| prompt caching Anthropic | `cache_control` não é repassado; usage reflete o cache próprio do commandcode |
| PDF/document | continua rejeitado com 400; `/alpha/generate` não oferece tradução fiel |
| APIs Anthropic auxiliares | batches, files e managed agents permanecem fora de escopo |
| tools server-side | argumentos não são antecipados porque `providerExecuted` só chega no evento final |

## Verificação

A suíte mock cobre, entre outros:

- tool input incremental e tools paralelas intercaladas;
- cache sem dupla contagem;
- resposta vazia stream e não-stream;
- reasoning dedicado, inline e redacted;
- round-trip de tool;
- imagem em tool result;
- keepalive, idle timeout e cancelamento;
- erros HTTP e mid-stream;
- SDK oficial Anthropic montando `finalMessage()`;
- tokenizer e estimativa de imagem.

Após os ajustes: `npm run typecheck` e `npm run test:mock` passam integralmente
(175/175). A validação paga contra a API real também passou em todos os caminhos
Anthropic exercitados: stream, não-stream, tool round-trip, stop sequence, effort e SDK.

## Conclusão

O proxy já tinha boa compatibilidade geral, mas a avaliação anterior priorizou dois
problemas herdados do wire do routatic que não se reproduzem da mesma forma no
commandcode. Os problemas efetivos mais relevantes eram:

1. dupla contagem de tokens cacheados;
2. perda do streaming incremental dos argumentos de tools;
3. respostas vazias fora do contrato;
4. reasoning inline e imagens de tool result descartados;
5. tokenizer diferente do documentado e pacing sem limite.

Esses pontos foram corrigidos. O que permanece é limitação explícita do
`/alpha/generate`, não incompatibilidade acidental do adaptador.
