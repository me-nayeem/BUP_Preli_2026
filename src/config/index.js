const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

const env = (name) =>
  process.env[name]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim() || undefined;
const num = (name, fallback) => Number(env(name)) || fallback;

function provider(prefix, label, defaults = {}) {
  return {
    label,
    baseUrl: env(`${prefix}_BASE_URL`) ?? defaults.baseUrl,
    apiKey: env(`${prefix}_API_KEY`) ?? defaults.apiKey,
    model: env(`${prefix}_MODEL`),
    reasoningEffort: env(`${prefix}_REASONING_EFFORT`) ?? defaults.reasoningEffort,
    jsonMode: env("LLM_JSON_MODE") !== "false",
  };
}

const primary = provider("LLM", "primary", { baseUrl: GEMINI_OPENAI_BASE_URL });
const fallback = provider("LLM_FALLBACK", "fallback", primary);
const isUsable = (p) => Boolean(p.baseUrl && p.apiKey && p.model);

module.exports = {
  port: num("PORT", 8000),
  host: env("HOST") ?? "0.0.0.0",
  llm: {
    providers: [primary, fallback].filter(isUsable),
    timeoutMs: num("LLM_TIMEOUT_MS", 8000),
    totalBudgetMs: num("LLM_TOTAL_BUDGET_MS", 22000),
    maxTokens: num("LLM_MAX_TOKENS", 2048),
  },
};
