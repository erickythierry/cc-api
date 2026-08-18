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

// resolve id de modelo: se tem sufixo de esforço, devolve base + effort
export function resolveModel(id: string): { id: string; effort: string | null } {
  const m = MODELS.find((x) => x.id === id);
  if (m?.effort) return { id: m.base as string, effort: m.effort };
  return { id, effort: null };
}

export const EFFORT_LEVELS: string[] = ["low", "medium", "high", "xhigh", "max"];
