const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { cases } = require("./fixtures/public_sample_cases.json");
const { validateScenario } = require("../src/validators/scenario.validator");
const { replay } = require("../src/services/replay.service");
const { planFromInterpretations } = require("../src/services/energy.service");
const { seededRandom, noOp } = require("./helpers");

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let child;

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LLM_MODEL: "",
      LLM_FALLBACK_MODEL: "",
      LLM_FALLBACK2_MODEL: "",
    },
    stdio: "ignore",
  });
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (Date.now() - started > 10_000) throw new Error("server did not become healthy within 10s");
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`server healthy ${Date.now() - started} ms after spawn`);
});

test.after(() => child.kill());

function perturbedCase(rng, k) {
  const input = structuredClone(cases[k % cases.length].input);
  input.scenario_id = `LOAD-${k}`;
  for (const h of input.hours) {
    h.demand_kwh = Math.round(h.demand_kwh * (0.7 + rng.next() * 0.6));
    h.solar_kwh = Math.round(h.solar_kwh * rng.next() * 1.5);
    h.tariff_bdt_per_kwh = Math.max(1, Math.round(h.tariff_bdt_per_kwh * (0.5 + rng.next())));
  }
  return input;
}

const post = (body) =>
  fetch(`${base}/optimize-energy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];

test("500 concurrent requests: all 200, ids echoed, every plan replay-clean", async () => {
  const rng = seededRandom(7);
  const inputs = Array.from({ length: 500 }, (_, k) => perturbedCase(rng, k));
  const started = Date.now();
  const responses = await Promise.all(inputs.map(post));
  const elapsed = Date.now() - started;
  for (let k = 0; k < inputs.length; k++) {
    assert.equal(responses[k].status, 200, `LOAD-${k}`);
    const body = await responses[k].json();
    assert.equal(body.scenario_id, `LOAD-${k}`);
    const sc = validateScenario(inputs[k]).scenario;
    assert.deepEqual(replay(sc, body.directive_interpretation, body), [], `LOAD-${k}`);
  }
  console.log(`500 concurrent requests completed in ${elapsed} ms`);
});

test("mixed valid and malformed traffic keeps correct status codes", async () => {
  const rng = seededRandom(11);
  const jobs = Array.from({ length: 200 }, (_, k) => {
    const kind = k % 4;
    if (kind === 0) return { expect: 400, body: "{broken" };
    if (kind === 1) return { expect: 400, body: { scenario_id: "x" } };
    if (kind === 2) {
      const body = perturbedCase(rng, k);
      body.battery.initial_energy_kwh = -1;
      return { expect: 422, body };
    }
    return { expect: 200, body: perturbedCase(rng, k) };
  });
  const statuses = await Promise.all(jobs.map(async (j) => (await post(j.body)).status));
  statuses.forEach((s, k) => assert.equal(s, jobs[k].expect, `job ${k}`));
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("200 sequential requests: p95 latency well under 5s", async () => {
  const rng = seededRandom(23);
  const times = [];
  for (let k = 0; k < 200; k++) {
    const t = performance.now();
    const res = await post(perturbedCase(rng, k));
    await res.json();
    assert.equal(res.status, 200);
    times.push(performance.now() - t);
  }
  const value = p95(times);
  console.log(`sequential p95 ${value.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms`);
  assert.ok(value < 5000);
});

test("3000 sequential solves stay stable (WASM solver endurance)", async () => {
  const rng = seededRandom(99);
  const started = Date.now();
  for (let k = 0; k < 3000; k++) {
    const input = perturbedCase(rng, k);
    input.operator_notes = ["x"];
    const sc = validateScenario(input).scenario;
    const body = await planFromInterpretations(sc, [noOp(0)]);
    assert.equal(body.hourly_plan.length, 24);
  }
  const ms = Date.now() - started;
  console.log(
    `3000 solves in ${ms} ms (${(ms / 3000).toFixed(2)} ms/solve), heap ${process.memoryUsage().heapUsed >> 20} MB`,
  );
});
