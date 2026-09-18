process.env.LLM_BASE_URL = "http://llm.invalid/v1";
process.env.LLM_API_KEY = "secret-test-key";
process.env.LLM_MODEL = "primary-model";
process.env.LLM_FALLBACK_MODEL = "fallback-model";
process.env.LLM_TIMEOUT_MS = "300";
process.env.LLM_TOTAL_BUDGET_MS = "3000";

const test = require("node:test");
const assert = require("node:assert/strict");
const { interpretAll, clearCache } = require("../src/services/interpreter.service");

const BATTERY = { capacity_kwh: 200 };
const realWarn = console.warn;
let calls;
let warnings;

function mockLlm(handler) {
  calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const call = { url, body, auth: init.headers.Authorization, user: body.messages.at(-1).content };
    calls.push(call);
    const reply = await handler(call, calls.length, init.signal);
    if (typeof reply === "number") return new Response("{}", { status: reply });
    const content = typeof reply === "string" ? reply : JSON.stringify(reply);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
}

test.beforeEach(() => {
  clearCache();
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
});
test.afterEach(() => (console.warn = realWarn));

const SOLAR = {
  directive_type: "solar_reduction",
  windows: [{ start_hour: 13, end_hour: 15 }],
  remaining_percent: 20,
  reduction_percent: 80,
  explanation: "Solar drops.",
};
const NO_CHARGE = { directive_type: "no_charge_window", windows: [{ start_hour: 2, end_hour: 5 }], explanation: "x" };
const NO_OP = { directive_type: "no_op", windows: [], explanation: "Unrelated." };
const results = (...items) => ({ results: items.map((it, index) => ({ index, ...it })) });

test("one batched call interprets all notes in order", async () => {
  mockLlm(() => results(SOLAR, NO_CHARGE, NO_OP));
  const out = await interpretAll(["a", "b", "c"], BATTERY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "primary-model");
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].url, "http://llm.invalid/v1/chat/completions");
  assert.deepEqual(
    out.map((o) => [o.note_index, o.directive_type, o.applies]),
    [
      [0, "solar_reduction", true],
      [1, "no_charge_window", true],
      [2, "no_op", false],
    ],
  );
  assert.deepEqual(out[0].structured_adjustment, { hours: [13, 14], factor: 0.2 });
});

test("the LLM sees only note text, never scenario numbers", async () => {
  mockLlm(() => results(NO_OP));
  await interpretAll(["The cafeteria menu changes."], { capacity_kwh: 987654 });
  const sent = JSON.stringify(calls[0].body.messages);
  assert.ok(!sent.includes("987654"));
});

test("results returned out of order are realigned by index", async () => {
  mockLlm(() => ({
    results: [
      { index: 1, ...NO_OP },
      { index: 0, ...NO_CHARGE },
    ],
  }));
  const out = await interpretAll(["charge note", "menu note"], BATTERY);
  assert.deepEqual(
    out.map((o) => o.directive_type),
    ["no_charge_window", "no_op"],
  );
});

test("only the note that failed guardrails is re-asked, with feedback", async () => {
  mockLlm((call, n) =>
    n === 1 ? results(SOLAR, { directive_type: "battery_limit", windows: [] }) : results(NO_CHARGE),
  );
  const out = await interpretAll(["solar note", "charging note"], BATTERY);
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /charging note/);
  assert.doesNotMatch(calls[1].user, /solar note/);
  assert.match(calls[1].user, /failed validation: directive_type must be one of/);
  assert.deepEqual(
    out.map((o) => o.directive_type),
    ["solar_reduction", "no_charge_window"],
  );
});

test("unparseable reply triggers a retry", async () => {
  mockLlm((call, n) => (n === 1 ? "Sure! Here is my answer." : results(NO_CHARGE)));
  const out = await interpretAll(["charging note"], BATTERY);
  assert.equal(calls.length, 2);
  assert.equal(out[0].directive_type, "no_charge_window");
});

test("wrong result count triggers a retry", async () => {
  mockLlm((call, n) => (n === 1 ? results(NO_OP) : results(NO_OP, NO_CHARGE)));
  const out = await interpretAll(["menu", "charging"], BATTERY);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    out.map((o) => o.directive_type),
    ["no_op", "no_charge_window"],
  );
});

test("rate limit on primary moves to the fallback model", async () => {
  mockLlm((call) => (call.body.model === "primary-model" ? 429 : results(NO_CHARGE)));
  const out = await interpretAll(["charging note"], BATTERY);
  assert.equal(out[0].directive_type, "no_charge_window");
  assert.equal(calls.at(-1).body.model, "fallback-model");
});

test("when every model times out, the last one is retried within the budget", async () => {
  mockLlm(
    (call, n, signal) =>
      new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  );
  const started = Date.now();
  const out = await interpretAll(["charging note"], BATTERY);
  assert.deepEqual(
    calls.map((c) => c.body.model),
    ["primary-model", "fallback-model", "fallback-model"],
  );
  assert.equal(out[0].directive_type, "no_op");
  assert.ok(Date.now() - started < 3000);
});

test("overloaded primary (503) goes straight to the fallback without a second primary call", async () => {
  mockLlm((call) => (call.body.model === "primary-model" ? 503 : results(NO_CHARGE)));
  const out = await interpretAll(["charging note"], BATTERY);
  assert.equal(out[0].directive_type, "no_charge_window");
  assert.deepEqual(
    calls.map((c) => c.body.model),
    ["primary-model", "fallback-model"],
  );
});

test("timeouts fall through to the fallback and stay within budget", async () => {
  mockLlm(
    (call, n, signal) =>
      new Promise((resolve, reject) => {
        if (call.body.model === "fallback-model") return resolve(results(NO_CHARGE));
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const started = Date.now();
  const out = await interpretAll(["charging note"], BATTERY);
  assert.equal(out[0].directive_type, "no_charge_window");
  assert.equal(calls.filter((c) => c.body.model === "primary-model").length, 1);
  assert.ok(Date.now() - started < 3000);
});

test("provider down everywhere -> controlled no_op for every note, no throw", async () => {
  mockLlm(() => 500);
  const out = await interpretAll(["a", "b", "c"], BATTERY);
  assert.deepEqual(
    calls.map((c) => c.body.model),
    ["primary-model", "fallback-model", "fallback-model"],
  );
  for (const [i, o] of out.entries()) {
    assert.deepEqual([o.note_index, o.applies, o.directive_type, o.structured_adjustment], [i, false, "no_op", null]);
  }
});

test("invalid JSON-mode parameter (HTTP 400) retries without response_format", async () => {
  mockLlm((call) => (call.body.response_format ? 400 : results(NO_CHARGE)));
  const out = await interpretAll(["charging note"], BATTERY);
  assert.equal(out[0].directive_type, "no_charge_window");
  assert.equal(calls.length, 2);
});

test("cached notes skip the LLM, percentages re-normalized per battery", async () => {
  mockLlm(() =>
    results({
      directive_type: "minimum_battery_reserve",
      windows: [{ start_hour: 18, end_hour: 21 }],
      reserve_percent_of_capacity: 50,
    }),
  );
  const a = await interpretAll(["Keep half the battery from 6 to 9 PM."], { capacity_kwh: 200 });
  const b = await interpretAll(["  keep HALF the battery from 6 to 9 PM. "], { capacity_kwh: 300 });
  assert.equal(calls.length, 1);
  assert.equal(a[0].structured_adjustment.minimum_energy_kwh, 100);
  assert.equal(b[0].structured_adjustment.minimum_energy_kwh, 150);
});

test("API key is sent only in the Authorization header, never logged", async () => {
  mockLlm((call, n) => (n <= 2 ? 401 : 500));
  await interpretAll(["x"], BATTERY);
  assert.equal(calls[0].auth, "Bearer secret-test-key");
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every((w) => !w.includes("secret-test-key")));
});

test("auth failure on primary is not retried on the same provider", async () => {
  mockLlm((call) => (call.body.model === "primary-model" ? 401 : results(NO_OP)));
  await interpretAll(["x"], BATTERY);
  assert.equal(calls.filter((c) => c.body.model === "primary-model").length, 1);
});
