// Catálogo de modelos do commandcode (extraído do bundle command-code@1.27.1).
// Plano Go libera opensource (provider "cai"); premium (Claude/GPT) exige plano maior.
// O servidor rejeita modelo fora do plano com model_not_in_plan.

export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export const MODELS = [
  // opensource (provider cai) — liberados no plano Go
  { id: "deepseek/deepseek-v4-flash", context: 1000000 },
  { id: "deepseek/deepseek-v4-pro", context: 1000000 },
  { id: "moonshotai/Kimi-K2.5", context: 256000 },
  { id: "moonshotai/Kimi-K2.6", context: 256000 },
  { id: "moonshotai/Kimi-K3", context: 1000000 },
  { id: "zai-org/GLM-5", context: 200000 },
  { id: "zai-org/GLM-5.1", context: 200000 },
  { id: "zai-org/GLM-5.2", context: 1000000 },
  { id: "zai-org/GLM-5.2-Fast", context: 1000000 },
  { id: "zai-org/GLM-5.3", context: 1000000 },
  { id: "MiniMaxAI/MiniMax-M3-Free", context: 1000000 },
  { id: "MiniMaxAI/MiniMax-M3", context: 1000000 },
  { id: "MiniMaxAI/MiniMax-M2.7", context: 1000000 },
  { id: "MiniMaxAI/MiniMax-M2.5", context: 200000 },
  { id: "Qwen/Qwen3.7-Flash", context: 1000000 },
  { id: "Qwen/Qwen3.7-Max", context: 1000000 },
  { id: "Qwen/Qwen3.7-Plus", context: 1000000 },
  { id: "Qwen/Qwen3.8-Max", context: 1000000 },
  { id: "xiaomi/mimo-v2.5", context: 1000000, vision: true },
  { id: "xiaomi/mimo-v2.5-pro", context: 1000000, vision: true },
  { id: "stepfun/Step-3.5-Flash", context: 1000000 },
  { id: "stepfun/Step-3.7-Flash", context: 256000 },
  { id: "tencent/Hy3", context: 262144 },
  { id: "tencent/hy3-paid", context: 262144 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", context: 1000000 },
  { id: "poolside/laguna-s-2.1-free", context: 256000 },
  { id: "inclusionai/ling-3.0-flash-free", context: 256000 },
  { id: "thinkingmachines/inkling", context: 256000 },
  { id: "thinkingmachines/inkling-small", context: 1000000 },
  // via vercel-ai-gateway / openrouter (depende do plano)
  { id: "google/gemini-3.5-flash", context: 1000000 },
  { id: "google/gemini-3.6-flash", context: 1000000 },
  { id: "google/gemini-3.7-flash", context: 1048576 },
  { id: "sakana/fugu-ultra", context: 1000000 },
  { id: "xai/grok-4.5", context: 500000 },
  { id: "xai/grok-4.6", context: 500000 },
  { id: "meta/muse-spark-1.1", context: 1048576 },
  { id: "meta/muse-spark-1.2", context: 1048576 },
  // premium (Claude / GPT) — plano Go bloqueia
  { id: "claude-haiku-4-5-20251001", context: 200000 },
  { id: "claude-sonnet-5", context: 1000000 },
  { id: "claude-opus-5", context: 1000000 },
  { id: "gpt-5.6-sol", context: 1050000 },
  { id: "gpt-5.5", context: 400000 },
];
