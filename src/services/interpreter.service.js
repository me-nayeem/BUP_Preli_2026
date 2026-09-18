const config = require("../config");
const { SYSTEM_PROMPT, buildUserMessage } = require("../prompts/interpreter.prompt");
const { chatCompletion } = require("./llm.client");
const { normalizeNote, parseBatch, safeNoOp } = require("./guardrails.service");

const CACHE_LIMIT = 2000;
const cache = new Map();
const cacheKey = (note) => note.trim().toLowerCase().replace(/\s+/g, " ");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function remember(note, raw) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(cacheKey(note), raw);
}

function attemptPlan() {
  return config.llm.providers.flatMap((p) => [p, p]);
}

async function requestNote(provider, note, feedback, timeoutMs) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage([note], [feedback]) },
  ];
  const options = { timeoutMs, maxTokens: config.llm.maxTokens };
  try {
    return await chatCompletion(provider, messages, options);
  } catch (err) {
    if (err.status !== 400 || (!provider.jsonMode && !provider.reasoningEffort)) throw err;
    provider.jsonMode = false;
    provider.reasoningEffort = undefined;
    return chatCompletion(provider, messages, options);
  }
}

async function interpretAll(notes, battery) {
  const results = Array(notes.length).fill(null);
  notes.forEach((note, i) => {
    const cached = cache.get(cacheKey(note));
    const r = cached && normalizeNote(cached, i, battery);
    if (r?.ok) results[i] = r.value;
  });

  let pending = results.flatMap((r, i) => (r ? [] : [i]));
  const feedback = new Map();
  const deadline = Date.now() + config.llm.totalBudgetMs;
  const exhausted = new Set();

  for (const provider of attemptPlan()) {
    if (!pending.length) break;
    if (exhausted.has(provider)) continue;
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    const timeoutMs = Math.min(config.llm.timeoutMs, remaining);

    const replies = await Promise.allSettled(
      pending.map((i) => requestNote(provider, notes[i], feedback.get(i), timeoutMs)),
    );
    let failure = null;
    pending.forEach((i, k) => {
      const reply = replies[k];
      if (reply.status === "rejected") {
        failure ??= reply.reason;
        return;
      }
      const parsed = parseBatch(reply.value, 1);
      if (!parsed.ok) {
        feedback.set(i, { output: JSON.stringify(String(reply.value).slice(0, 300)), error: parsed.error });
        console.warn(`LLM ${provider.label}: note ${i} unusable reply (${parsed.error})`);
        return;
      }
      const r = normalizeNote(parsed.value[0], i, battery);
      if (r.ok) {
        results[i] = r.value;
        feedback.delete(i);
        remember(notes[i], parsed.value[0]);
      } else {
        feedback.set(i, { output: JSON.stringify(parsed.value[0]).slice(0, 400), error: r.error });
        console.warn(`LLM ${provider.label}: note ${i} rejected by guardrails (${r.error})`);
      }
    });
    pending = pending.filter((i) => !results[i]);

    if (failure) {
      console.warn(`LLM ${provider.label}: call failed (${failure.message})`);
      const hasAlternative = config.llm.providers.some((p) => p !== provider && !exhausted.has(p));
      const overloaded = failure.status === 429 || failure.status >= 500;
      const transient = overloaded || failure.message === "timeout" || failure.message === "network_error";
      const unusable = [401, 403, 404].includes(failure.status);
      if (unusable || (transient && hasAlternative)) exhausted.add(provider);
      else if (overloaded) await sleep(Math.min(1000, Math.max(0, deadline - Date.now() - 1500)));
    }
  }

  return results.map((r, i) => r ?? safeNoOp(i));
}

const clearCache = () => cache.clear();

module.exports = { interpretAll, clearCache };
