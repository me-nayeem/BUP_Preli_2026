const test = require("node:test");
const assert = require("node:assert/strict");
const { planFromInterpretations } = require("../src/services/energy.service");
const { range, toyScenario, noOp, directive } = require("./helpers");

const TOL = 0.01;
const TOY_S = { 12: 100, 13: 100 };

const assertCost = (body, expected) =>
  assert.ok(Math.abs(body.total_cost_bdt - expected) <= TOL, `expected cost ${expected}, got ${body.total_cost_bdt}`);
const at = (body, hours) => hours.map((h) => body.hourly_plan[h]);

test("T1 no_op only -> 16500, battery neutral", async () => {
  const body = await planFromInterpretations(toyScenario(), [noOp(0)]);
  assertCost(body, 16500);
  assert.equal(body.hourly_plan[23].battery_energy_after_kwh, 200);
});

test("T2 no_charge 0-9 -> 17000", async () => {
  const body = await planFromInterpretations(toyScenario(), [
    directive(0, "no_charge_window", { hours: range(0, 10) }),
  ]);
  assertCost(body, 17000);
  assert.ok(at(body, range(0, 10)).every((p) => p.battery_action !== "charge"));
});

test("T3 no_discharge 12-21 -> 17000", async () => {
  const body = await planFromInterpretations(toyScenario(), [
    directive(0, "no_discharge_window", { hours: range(12, 22) }),
  ]);
  assertCost(body, 17000);
  assert.ok(at(body, range(12, 22)).every((p) => p.battery_action !== "discharge"));
});

test("T4 T2 + T3 + distractor -> 17000, three entries in order", async () => {
  const body = await planFromInterpretations(toyScenario({ notes: 3 }), [
    directive(0, "no_charge_window", { hours: range(0, 10) }),
    directive(1, "no_discharge_window", { hours: range(12, 22) }),
    noOp(2),
  ]);
  assertCost(body, 17000);
  assert.deepEqual(
    body.directive_interpretation.map((d) => d.note_index),
    [0, 1, 2],
  );
});

test("T5 max_grid 0 at 22-23 -> 16500", async () => {
  const body = await planFromInterpretations(toyScenario(), [
    directive(0, "max_grid_window", { hours: [22, 23], max_grid_kwh: 0 }),
  ]);
  assertCost(body, 16500);
  assert.ok(at(body, [22, 23]).every((p) => p.grid_kwh === 0));
});

test("T6 max_grid 50 at 6-11 -> 18000", async () => {
  const body = await planFromInterpretations(toyScenario(), [
    directive(0, "max_grid_window", { hours: range(6, 12), max_grid_kwh: 50 }),
  ]);
  assertCost(body, 18000);
  assert.ok(at(body, range(6, 12)).every((p) => p.grid_kwh <= 50 + TOL));
});

test("T7 reserve 480 at 11-12 -> 16500", async () => {
  const body = await planFromInterpretations(toyScenario(), [
    directive(0, "minimum_battery_reserve", { hours: [11, 12], minimum_energy_kwh: 480 }),
  ]);
  assertCost(body, 16500);
  assert.ok(at(body, [11, 12]).every((p) => p.battery_energy_after_kwh >= 480 - TOL));
});

test("T8 TOY-S no_op -> 14500, solar fully used", async () => {
  const body = await planFromInterpretations(toyScenario({ solarAt: TOY_S }), [noOp(0)]);
  assertCost(body, 14500);
  assert.ok(at(body, [12, 13]).every((p) => p.solar_used_kwh === 100));
});

test("T9 TOY-S solar factor 0.2 at 12-13 -> 16100", async () => {
  const body = await planFromInterpretations(toyScenario({ solarAt: TOY_S }), [
    directive(0, "solar_reduction", { hours: [12, 13], factor: 0.2 }),
  ]);
  assertCost(body, 16100);
  assert.ok(at(body, [12, 13]).every((p) => p.solar_used_kwh <= 20 + TOL));
});

test("T10 TOY-S overlapping solar reductions multiply -> 15750", async () => {
  const body = await planFromInterpretations(toyScenario({ notes: 2, solarAt: TOY_S }), [
    directive(0, "solar_reduction", { hours: [12, 13], factor: 0.5 }),
    directive(1, "solar_reduction", { hours: [13, 14], factor: 0.5 }),
  ]);
  assertCost(body, 15750);
  assert.equal(body.hourly_plan[12].solar_used_kwh, 50);
  assert.equal(body.hourly_plan[13].solar_used_kwh, 25);
});

test("infeasible directives -> 422", async () => {
  await assert.rejects(
    planFromInterpretations(toyScenario(), [directive(0, "max_grid_window", { hours: range(0, 24), max_grid_kwh: 0 })]),
    (err) => err.status === 422,
  );
});
