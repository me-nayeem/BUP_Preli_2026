const test = require("node:test");
const assert = require("node:assert/strict");
const { planFromInterpretations } = require("../src/services/energy.service");
const { replay } = require("../src/services/replay.service");
const { toyScenario, noOp, directive } = require("./helpers");

async function validBody(interps) {
  return structuredClone(await planFromInterpretations(toyScenario({ notes: interps.length }), interps));
}

const expectError = (sc, interps, body, pattern) => {
  const errs = replay(sc, interps, body);
  assert.ok(
    errs.some((e) => pattern.test(e)),
    `expected ${pattern}, got ${JSON.stringify(errs)}`,
  );
};

test("valid plan replays clean", async () => {
  const interps = [noOp(0)];
  assert.deepEqual(replay(toyScenario(), interps, await validBody(interps)), []);
});

test("detects energy balance violation", async () => {
  const body = await validBody([noOp(0)]);
  body.hourly_plan[5].grid_kwh += 10;
  expectError(toyScenario(), [noOp(0)], body, /energy balance/);
});

test("detects broken battery transition and neutrality", async () => {
  const body = await validBody([noOp(0)]);
  body.hourly_plan[23].battery_energy_after_kwh -= 20;
  expectError(toyScenario(), [noOp(0)], body, /battery transition/);
  expectError(toyScenario(), [noOp(0)], body, /end-of-day neutrality/);
});

test("detects no_charge violation", async () => {
  const body = await validBody([noOp(0)]);
  const chargingHour = body.hourly_plan.find((p) => p.battery_action === "charge").hour;
  const interps = [directive(0, "no_charge_window", { hours: [chargingHour] })];
  expectError(toyScenario(), interps, body, /no_charge/);
});

test("detects grid cap violation", async () => {
  const body = await validBody([noOp(0)]);
  const interps = [directive(0, "max_grid_window", { hours: [0], max_grid_kwh: 10 })];
  expectError(toyScenario(), interps, body, /grid cap/);
});

test("detects effective solar overuse", async () => {
  const sc = toyScenario({ solarAt: { 12: 100 } });
  const body = structuredClone(await planFromInterpretations(sc, [noOp(0)]));
  const interps = [directive(0, "solar_reduction", { hours: [12], factor: 0.1 })];
  expectError(sc, interps, body, /effective solar/);
});

test("detects totals mismatch", async () => {
  const body = await validBody([noOp(0)]);
  body.total_cost_bdt += 1;
  expectError(toyScenario(), [noOp(0)], body, /total_cost_bdt mismatch/);
});

test("detects bad interpretation semantics", async () => {
  const body = await validBody([noOp(0)]);
  const bad = [{ ...noOp(0), applies: true }];
  expectError(toyScenario(), bad, body, /no_op semantics/);
  const unsorted = [directive(0, "no_charge_window", { hours: [3, 2] })];
  expectError(toyScenario(), unsorted, body, /hours must be unique ascending/);
});
