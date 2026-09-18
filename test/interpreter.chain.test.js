process.env.LLM_BASE_URL = "http://openai.invalid/v1";
process.env.LLM_API_KEY = "openai-key";
process.env.LLM_MODEL = "gpt-4o-mini";
process.env.LLM_FALLBACK_BASE_URL = "http://gemini.invalid/v1";
process.env.LLM_FALLBACK_API_KEY = "gemini-key";
process.env.LLM_FALLBACK_MODEL = "gemini-fallback";
process.env.LLM_FALLBACK_REASONING_EFFORT = "low";
process.env.LLM_FALLBACK2_MODEL = "gemini-backup";
process.env.LLM_TIMEOUT_MS = "300";
process.env.LLM_TOTAL_BUDGET_MS = "3000";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const config = require("../src/config");
const { interpretAll, clearCache } = require("../src/services/interpreter.service");

const NO_CHARGE = { index: 0, directive_type: "no_charge_window", windows: [{ start_hour: 2, end_hour: 5 }] };
let calls;

function mockLlm(handler) {
  calls = [];
  global.fetch = async (url, init) => {
    const call = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    calls.push(call);
    const reply = handler(call);
    if (typeof reply === "number") return new Response("{}", { status: reply });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  };
}

function configIn(env) {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify(require('./src/config').llm.providers.map((p) => [p.label, p.baseUrl, p.apiKey])))",
    ],
    { cwd: path.join(__dirname, ".."), env: { PATH: process.env.PATH, ...env } },
  );
  return JSON.parse(out);
}

test.beforeEach(() => {
  clearCache();
  console.warn = () => {};
});

test("three providers are configured in order", () => {
  assert.deepEqual(
    config.llm.providers.map((p) => [p.label, p.model]),
    [
      ["primary", "gpt-4o-mini"],
      ["fallback", "gemini-fallback"],
      ["fallback2", "gemini-backup"],
    ],
  );
});

test("each provider gets its own URL, key and reasoning_effort", async () => {
  mockLlm((call) => (call.body.model === "gemini-fallback" ? { results: [NO_CHARGE] } : 503));
  const out = await interpretAll(["charging note"], { capacity_kwh: 100 });
  assert.equal(out[0].directive_type, "no_charge_window");
  const [openai, gemini] = calls;
  assert.equal(openai.url, "http://openai.invalid/v1/chat/completions");
  assert.equal(openai.auth, "Bearer openai-key");
  assert.equal("reasoning_effort" in openai.body, false);
  assert.equal(gemini.url, "http://gemini.invalid/v1/chat/completions");
  assert.equal(gemini.auth, "Bearer gemini-key");
  assert.equal(gemini.body.reasoning_effort, "low");
});

test("third provider inherits URL and key from the previous one, not its reasoning_effort", async () => {
  mockLlm((call) => (call.body.model === "gemini-backup" ? { results: [NO_CHARGE] } : 429));
  const out = await interpretAll(["charging note"], { capacity_kwh: 100 });
  assert.equal(out[0].directive_type, "no_charge_window");
  assert.deepEqual(
    calls.map((c) => c.body.model),
    ["gpt-4o-mini", "gemini-fallback", "gemini-backup"],
  );
  assert.equal(calls[2].auth, "Bearer gemini-key");
  assert.equal(calls[2].url, "http://gemini.invalid/v1/chat/completions");
  assert.equal("reasoning_effort" in calls[2].body, false);
});

test("primary defaults to the OpenAI base URL", () => {
  assert.deepEqual(configIn({ LLM_API_KEY: "k", LLM_MODEL: "gpt-4o-mini" }), [
    ["primary", "https://api.openai.com/v1", "k"],
  ]);
});

test("a provider on a different URL never receives the previous provider's key", () => {
  const labels = configIn({
    LLM_API_KEY: "openai-key",
    LLM_MODEL: "gpt-4o-mini",
    LLM_FALLBACK_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
    LLM_FALLBACK_MODEL: "gemini-3.5-flash-lite",
  }).map(([label]) => label);
  assert.deepEqual(labels, ["primary"]);
});
