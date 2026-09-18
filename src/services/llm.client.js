class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function chatCompletion(provider, messages, { timeoutMs, maxTokens }) {
  const body = { model: provider.model, messages, temperature: 0, max_tokens: maxTokens };
  if (provider.jsonMode) body.response_format = { type: "json_object" };
  if (provider.reasoningEffort) body.reasoning_effort = provider.reasoningEffort;

  let res;
  try {
    res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(err.name === "TimeoutError" ? "timeout" : "network_error");
  }
  if (!res.ok) throw new LlmError(`http_${res.status}`, res.status);
  const data = await res.json().catch(() => null);
  return data?.choices?.[0]?.message?.content ?? "";
}

module.exports = { chatCompletion, LlmError };
