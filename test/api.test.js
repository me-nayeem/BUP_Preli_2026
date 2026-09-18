const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const { cases } = require("./fixtures/public_sample_cases.json");
const { validateScenario } = require("../src/validators/scenario.validator");
const { replay } = require("../src/services/replay.service");
const { startServer } = require("./helpers");

let server;
let base;

test.before(async () => ({ server, base } = await startServer(app)));
test.after(() => server.close());

const JSON_HEADERS = { "Content-Type": "application/json" };
const valid = () => structuredClone(cases[6].input);
const send = (body, headers = JSON_HEADERS) =>
  fetch(`${base}/optimize-energy`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const mutate = (fn) => {
  const body = valid();
  fn(body);
  return body;
};

async function expectJson(res, status) {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const body = await res.json();
  if (status >= 400) {
    assert.equal(typeof body.error, "string");
    assert.doesNotMatch(JSON.stringify(body), /at .+\.js|node_modules|<html/i);
  }
  return body;
}

function assertValidResponse(input, body) {
  const sc = validateScenario(input).scenario;
  assert.equal(body.scenario_id, input.scenario_id);
  assert.deepEqual(Object.keys(body).sort(), [
    "directive_interpretation",
    "hourly_plan",
    "peak_grid_kwh",
    "plan_summary",
    "scenario_id",
    "total_cost_bdt",
    "total_grid_kwh",
  ]);
  assert.equal(body.directive_interpretation.length, input.operator_notes.length);
  assert.deepEqual(replay(sc, body.directive_interpretation, body), []);
}

test("GET /health -> exactly {status: ok}", async () => {
  assert.deepEqual(await expectJson(await fetch(`${base}/health`), 200), { status: "ok" });
});

test("HEAD /health and trailing slash respond 200", async () => {
  assert.equal((await fetch(`${base}/health`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${base}/health/`)).status, 200);
});

test("wrong methods and unknown routes -> JSON 404", async () => {
  await expectJson(await fetch(`${base}/optimize-energy`), 404);
  await expectJson(await fetch(`${base}/health`, { method: "POST" }), 404);
  await expectJson(await fetch(`${base}/nope`), 404);
});

const MALFORMED = {
  "invalid JSON": "{bad",
  "truncated JSON": JSON.stringify(valid()).slice(0, 200),
  "trailing comma": '{"scenario_id":"x",}',
  "top-level string": '"hello"',
  "top-level number": "123",
  "top-level null": "null",
  "top-level true": "true",
};
for (const [name, raw] of Object.entries(MALFORMED)) {
  test(`400 malformed: ${name}`, async () => {
    await expectJson(await send(raw), 400);
  });
}

const STRUCTURAL = {
  "empty body": "",
  "empty object": {},
  "array body": [],
  "array of scenario": [valid()],
  "missing scenario_id": mutate((b) => delete b.scenario_id),
  "numeric scenario_id": mutate((b) => (b.scenario_id = 101)),
  "blank scenario_id": mutate((b) => (b.scenario_id = "   ")),
  "missing operator_notes": mutate((b) => delete b.operator_notes),
  "operator_notes string": mutate((b) => (b.operator_notes = "note")),
  "zero notes": mutate((b) => (b.operator_notes = [])),
  "four notes": mutate((b) => (b.operator_notes = ["a", "b", "c", "d"])),
  "empty-string note": mutate((b) => (b.operator_notes = [""])),
  "whitespace note": mutate((b) => (b.operator_notes = ["ok", "   "])),
  "numeric note": mutate((b) => (b.operator_notes = [42])),
  "null note": mutate((b) => (b.operator_notes = [null])),
  "missing hours": mutate((b) => delete b.hours),
  "hours object": mutate((b) => (b.hours = { 0: b.hours[0] })),
  "23 hours": mutate((b) => b.hours.pop()),
  "25 hours": mutate((b) => b.hours.push({ ...b.hours[0] })),
  "null hour entry": mutate((b) => (b.hours[3] = null)),
  "fractional hour": mutate((b) => (b.hours[3].hour = 3.5)),
  "string hour": mutate((b) => (b.hours[3].hour = "3")),
  "negative hour": mutate((b) => (b.hours[0].hour = -1)),
  "hour 24": mutate((b) => (b.hours[23].hour = 24)),
  "duplicate hour": mutate((b) => (b.hours[5].hour = 4)),
  "string demand": mutate((b) => (b.hours[0].demand_kwh = "180")),
  "null solar": mutate((b) => (b.hours[0].solar_kwh = null)),
  "missing tariff": mutate((b) => delete b.hours[0].tariff_bdt_per_kwh),
  "boolean tariff": mutate((b) => (b.hours[0].tariff_bdt_per_kwh = true)),
  "missing battery": mutate((b) => delete b.battery),
  "battery array": mutate((b) => (b.battery = [b.battery])),
  "battery null": mutate((b) => (b.battery = null)),
  "battery missing field": mutate((b) => delete b.battery.max_charge_kwh_per_hour),
  "battery string field": mutate((b) => (b.battery.capacity_kwh = "250")),
};
for (const [name, body] of Object.entries(STRUCTURAL)) {
  test(`400 structural: ${name}`, async () => {
    await expectJson(await send(body), 400);
  });
}

test("400: 1e400 overflows to Infinity", async () => {
  const raw = JSON.stringify(valid()).replace('"demand_kwh":', '"demand_kwh":1e400,"x":');
  await expectJson(await send(raw), 400);
});

test("400: payload over 1mb", async () => {
  const body = mutate((b) => (b.padding = "x".repeat(1_100_000)));
  assert.deepEqual(await expectJson(await send(body), 400), { error: "payload_too_large" });
});

const SEMANTIC = {
  "negative demand": mutate((b) => (b.hours[2].demand_kwh = -5)),
  "negative solar": mutate((b) => (b.hours[12].solar_kwh = -1)),
  "negative capacity": mutate((b) => (b.battery.capacity_kwh = -10)),
  "minimum above capacity": mutate((b) => (b.battery.minimum_energy_kwh = b.battery.capacity_kwh + 1)),
  "initial below minimum": mutate((b) => (b.battery.initial_energy_kwh = b.battery.minimum_energy_kwh - 1)),
  "initial above capacity": mutate((b) => (b.battery.initial_energy_kwh = b.battery.capacity_kwh + 1)),
  "value above 1e9": mutate((b) => (b.hours[0].demand_kwh = 1e10)),
};
for (const [name, body] of Object.entries(SEMANTIC)) {
  test(`422 semantic: ${name}`, async () => {
    await expectJson(await send(body), 422);
  });
}

const ACCEPTED = {
  "shuffled hours": mutate((b) => b.hours.reverse()),
  "extra top-level and nested fields": mutate((b) => {
    b.extra = { a: 1 };
    b.hours[0].note = "x";
    b.battery.chemistry = "LFP";
  }),
  "__proto__ key": mutate((b) => (b.__proto__ = { polluted: true })),
  "unicode and very long notes": mutate(
    (b) => (b.operator_notes = ["ব্যাটারি চার্জ হবে না ⚡ 2-4 PM", "x".repeat(10_000), "Café menu 🍕"]),
  ),
  "integers written as floats": JSON.stringify(valid()).replace(/"hour":(\d+),/g, '"hour":$1.0,'),
};
for (const [name, body] of Object.entries(ACCEPTED)) {
  test(`200 accepted: ${name}`, async () => {
    const input = typeof body === "string" ? JSON.parse(body) : body;
    assertValidResponse(input, await expectJson(await send(body), 200));
  });
}

const CONTENT_TYPES = {
  "no content-type": {},
  "text/plain": { "Content-Type": "text/plain" },
  "form-urlencoded": { "Content-Type": "application/x-www-form-urlencoded" },
  "json with charset": { "Content-Type": "application/json; charset=utf-8" },
};
for (const [name, headers] of Object.entries(CONTENT_TYPES)) {
  test(`200 content-type: ${name}`, async () => {
    const res = await fetch(`${base}/optimize-energy`, { method: "POST", headers, body: JSON.stringify(valid()) });
    assertValidResponse(valid(), await expectJson(res, 200));
  });
}

test("every public sample returns a valid, replay-clean response", async () => {
  for (const c of cases) assertValidResponse(c.input, await expectJson(await send(c.input), 200));
});
