// Catálogo de modelos do commandcode (extraído do bundle command-code@1.27.1).
// Modelos do plano Go: opensource (provider "cai"). Premium (Claude/GPT) e gateway
// (gemini/grok/meta/sakana) devolvem model_not_in_plan no Go — fora do catálogo.
// Cada modelo com `efforts` gera variantes <id>-<effort> (ex: deepseek/deepseek-v4-flash-high).
// Esforços por modelo (mapa de reasoning do bundle): deepseek-v4-* = high|max;
// GLM-5.3 = low|high|max; GLM-5.2 = high|max.

export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

// entrada do catálogo: base (`efforts` preenchido) ou variante de esforço (`base`/`effort`)
export interface Model {
  id: string;
  context: number;
  efforts?: string[];
  base?: string;
  effort?: string;
}

interface BaseModel {
  id: string;
  context: number;
  efforts: string[];
}

const BASE: BaseModel[] = [
  { id: "deepseek/deepseek-v4-flash", context: 1000000, efforts: ["high", "max"] },
  { id: "deepseek/deepseek-v4-pro", context: 1000000, efforts: ["high", "max"] },
  { id: "moonshotai/Kimi-K2.5", context: 256000, efforts: [] },
  { id: "moonshotai/Kimi-K2.6", context: 256000, efforts: [] },
  { id: "moonshotai/Kimi-K3", context: 1000000, efforts: [] },
  { id: "zai-org/GLM-5", context: 200000, efforts: [] },
  { id: "zai-org/GLM-5.1", context: 200000, efforts: [] },
  { id: "zai-org/GLM-5.2", context: 1000000, efforts: ["high", "max"] },
  { id: "zai-org/GLM-5.2-Fast", context: 1000000, efforts: ["high", "max"] },
  { id: "zai-org/GLM-5.3", context: 1000000, efforts: ["low", "high", "max"] },
  { id: "MiniMaxAI/MiniMax-M3-Free", context: 1000000, efforts: [] },
  { id: "MiniMaxAI/MiniMax-M3", context: 1000000, efforts: [] },
  { id: "MiniMaxAI/MiniMax-M2.7", context: 1000000, efforts: [] },
  { id: "MiniMaxAI/MiniMax-M2.5", context: 200000, efforts: [] },
  { id: "Qwen/Qwen3.7-Flash", context: 1000000, efforts: [] },
  { id: "Qwen/Qwen3.7-Max", context: 1000000, efforts: [] },
  { id: "Qwen/Qwen3.7-Plus", context: 1000000, efforts: [] },
  { id: "Qwen/Qwen3.8-Max", context: 1000000, efforts: ["low", "medium", "xhigh"] },
  { id: "xiaomi/mimo-v2.5", context: 1000000, efforts: [] },
  { id: "xiaomi/mimo-v2.5-pro", context: 1000000, efforts: [] },
  { id: "stepfun/Step-3.5-Flash", context: 1000000, efforts: [] },
  { id: "stepfun/Step-3.7-Flash", context: 256000, efforts: [] },
  { id: "tencent/Hy3", context: 262144, efforts: [] },
  { id: "tencent/hy3-paid", context: 262144, efforts: [] },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", context: 1000000, efforts: [] },
  { id: "poolside/laguna-s-2.1-free", context: 256000, efforts: [] },
  { id: "inclusionai/ling-3.0-flash-free", context: 256000, efforts: [] },
  { id: "thinkingmachines/inkling", context: 256000, efforts: [] },
  { id: "thinkingmachines/inkling-small", context: 1000000, efforts: [] },
];

function variants(b: BaseModel): Model[] {
  return (b.efforts ?? []).map((effort) => ({
    id: `${b.id}-${effort}`,
    base: b.id,
    effort,
    context: b.context,
  }));
}

export const MODELS: Model[] = [
  ...BASE.map((b) => ({ id: b.id, context: b.context, efforts: b.efforts ?? [] })),
  ...BASE.flatMap(variants),
];

export const EFFORT_LEVELS: string[] = ["low", "medium", "high", "xhigh", "max"];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
const BASE_BY_ID = new Map(BASE.map((b) => [b.id, b]));

// Sufixo de esforço fora do catálogo: `-low` num modelo que só declara `high|max`.
// A wire aceita os cinco níveis em qualquer modelo com reasoning (medido no flash:
// reasoning_tokens low < high < max, apesar de o bundle só listar high|max), então o
// sufixo resolve mesmo quando a variante não está no catálogo — o que o catálogo
// controla é o que aparece em GET /v1/models, não o que a wire aceita.
function splitEffortSuffix(id: string): { id: string; effort: string } | null {
  for (const level of EFFORT_LEVELS) {
    if (!id.endsWith(`-${level}`)) continue; // o hífen separa `-xhigh` de `-high`
    const base = id.slice(0, -(level.length + 1));
    if (BASE_BY_ID.has(base)) return { id: base, effort: level };
  }
  return null;
}

// Resolve id de modelo + esforço numa decisão só (os dois dialetos passam por aqui).
// Precedência: sufixo no id > esforço pedido pelo cliente. Modelo sem reasoning
// (`efforts: []`) descarta o esforço — mandar reasoning_effort ali é ruído na wire.
export function resolveModel(id: string, requested?: string | null): { id: string; effort: string | null } {
  const listed = BY_ID.get(id);
  const suffix = listed ? (listed.effort ? { id: listed.base as string, effort: listed.effort } : null) : splitEffortSuffix(id);

  const asked = typeof requested === "string" ? requested.trim().toLowerCase() : null;
  const base = suffix?.id ?? id;
  let effort = suffix?.effort ?? (asked && EFFORT_LEVELS.includes(asked) ? asked : null);

  if (effort && BASE_BY_ID.get(base)?.efforts.length === 0) effort = null;
  return { id: base, effort };
}
