const OPENAI_BASE_URL = "https://api.openai.com/v1";

const env = (name) =>
  process.env[name]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim() || undefined;
const num = (name, fallback) => Number(env(name)) || fallback;

function provider(prefix, label, defaults = {}) {
  const baseUrl = env(`${prefix}_BASE_URL`) ?? defaults.baseUrl;
  return {
    label,
    baseUrl,
    apiKey: env(`${prefix}_API_KEY`) ?? (baseUrl === defaults.baseUrl ? defaults.apiKey : undefined),
    model: env(`${prefix}_MODEL`),
    reasoningEffort: env(`${prefix}_REASONING_EFFORT`),
    jsonMode: env("LLM_JSON_MODE") !== "false",
  };
}

const primary = provider("LLM", "primary", { baseUrl: OPENAI_BASE_URL });
const fallback = provider("LLM_FALLBACK", "fallback", primary);
const fallback2 = provider("LLM_FALLBACK2", "fallback2", fallback);
const isUsable = (p) => Boolean(p.baseUrl && p.apiKey && p.model);

module.exports = {
  port: num("PORT", 8000),
  host: env("HOST") ?? "0.0.0.0",
  llm: {
    providers: [primary, fallback, fallback2].filter(isUsable),
    timeoutMs: num("LLM_TIMEOUT_MS", 8000),
    totalBudgetMs: num("LLM_TOTAL_BUDGET_MS", 22000),
    maxTokens: num("LLM_MAX_TOKENS", 2048),
  },
};
