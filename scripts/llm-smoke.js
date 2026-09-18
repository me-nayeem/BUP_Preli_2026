try {
  process.loadEnvFile();
} catch {}

const config = require("../src/config");
const { chatCompletion } = require("../src/services/llm.client");

async function listModels(provider) {
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  return { ids: (data.data ?? []).map((m) => String(m.id).replace(/^models\//, "")) };
}

(async () => {
  if (!config.llm.providers.length) {
    console.error("No LLM configured: set LLM_API_KEY and LLM_MODEL in .env");
    process.exit(1);
  }
  let failed = false;
  for (const provider of config.llm.providers) {
    console.log(
      `\n[${provider.label}] model=${provider.model} reasoning_effort=${provider.reasoningEffort ?? "(default)"}`,
    );
    const models = await listModels(provider).catch((e) => ({ error: e.message }));
    if (models.error) console.log(`  model list: ${models.error}`);
    else if (models.ids.includes(provider.model)) console.log("  model list: found");
    else {
      const similar = models.ids.filter((id) => id.includes("flash")).slice(0, 15);
      console.log(`  model list: NOT FOUND. Similar available: ${similar.join(", ")}`);
      failed = true;
    }
    const started = Date.now();
    try {
      const text = await chatCompletion(
        provider,
        [{ role: "user", content: 'Return exactly this JSON object: {"ok": true}' }],
        { timeoutMs: 15000, maxTokens: config.llm.maxTokens },
      );
      console.log(`  chat: ${Date.now() - started} ms, reply ${JSON.stringify(text.slice(0, 80))}`);
    } catch (err) {
      console.log(`  chat: FAILED after ${Date.now() - started} ms (${err.message})`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
})();
