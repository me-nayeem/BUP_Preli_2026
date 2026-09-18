const test = require("node:test");
const assert = require("node:assert/strict");
const { planFromInterpretations } = require("../src/services/energy.service");
const { optimize } = require("../src/services/optimizer.service");
const { buildLimits } = require("../src/services/limits.service");
const { range, makeScenario, TOY_BATTERY, noOp, directive } = require("./helpers");

const TOL = 0.01;
const ALL = range(0, 24);
const flat = (demand, solar, tariff) => () => ({ demand_kwh: demand, solar_kwh: solar, tariff_bdt_per_kwh: tariff });
const near = (a, b) => Math.abs(a - b) <= TOL;
const solve = (sc, interps = [noOp(0)]) => planFromInterpretations(sc, interps);

test("zero-capacity battery stays idle", async () => {
  const sc = makeScenario({
    hour: flat(100, 0, 5),
    battery: {
      capacity_kwh: 0,
      initial_energy_kwh: 0,
      minimum_energy_kwh: 0,
      max_charge_kwh_per_hour: 0,
      max_discharge_kwh_per_hour: 0,
    },
  });
  const body = await solve(sc);
  assert.ok(body.hourly_plan.every((p) => p.battery_action === "idle" && p.battery_kwh === 0));
  assert.ok(near(body.total_cost_bdt, 12000));
});

test("zero rate limits keep the battery idle despite arbitrage", async () => {
  const sc = makeScenario({
    hour: (h) => ({ demand_kwh: 100, solar_kwh: 0, tariff_bdt_per_kwh: h < 12 ? 1 : 50 }),
    battery: { ...TOY_BATTERY, max_charge_kwh_per_hour: 0, max_discharge_kwh_per_hour: 0 },
  });
  const body = await solve(sc);
  assert.ok(body.hourly_plan.every((p) => p.battery_action === "idle"));
});

test("solar surplus every hour -> zero grid, curtailment allowed", async () => {
  const body = await solve(makeScenario({ hour: flat(50, 400, 9), battery: TOY_BATTERY }));
  assert.equal(body.total_grid_kwh, 0);
  assert.equal(body.total_cost_bdt, 0);
  assert.ok(body.hourly_plan.every((p) => p.solar_used_kwh <= 400));
});

test("all-zero demand, solar and tariff", async () => {
  const body = await solve(makeScenario({ hour: flat(0, 0, 0), battery: TOY_BATTERY }));
  assert.equal(body.total_cost_bdt, 0);
  assert.equal(body.peak_grid_kwh, 0);
});

test("negative tariffs stay bounded and valid", async () => {
  const sc = makeScenario({
    hour: (h) => ({ demand_kwh: 100, solar_kwh: 50, tariff_bdt_per_kwh: h < 12 ? -5 : 10 }),
    battery: TOY_BATTERY,
  });
  const body = await solve(sc);
  assert.ok(Number.isFinite(body.total_cost_bdt));
});

test("values near the 1e9 limit solve", async () => {
  const sc = makeScenario({
    hour: (h) => ({ demand_kwh: 5e8, solar_kwh: h === 12 ? 1e8 : 0, tariff_bdt_per_kwh: 5 + (h % 4) }),
    battery: {
      capacity_kwh: 1e9,
      initial_energy_kwh: 5e8,
      minimum_energy_kwh: 1e8,
      max_charge_kwh_per_hour: 2e8,
      max_discharge_kwh_per_hour: 2e8,
    },
  });
  const body = await solve(sc);
  assert.ok(body.total_cost_bdt > 0);
});

test("many-decimal fractional inputs replay clean", async () => {
  const sc = makeScenario({
    hour: (h) => ({
      demand_kwh: 100 / 3 + h / 7,
      solar_kwh: h > 8 && h < 16 ? 200 / 3 : 0,
      tariff_bdt_per_kwh: 7.123456789 + h / 11,
    }),
    battery: {
      capacity_kwh: 333.3333333,
      initial_energy_kwh: 111.1111111,
      minimum_energy_kwh: 33.33333335,
      max_charge_kwh_per_hour: 45.4545454545,
      max_discharge_kwh_per_hour: 45.4545454545,
    },
  });
  const body = await solve(sc);
  assert.ok(near(body.hourly_plan[23].battery_energy_after_kwh, 111.1111111));
});

test("initial == minimum == capacity pins the battery", async () => {
  const body = await solve(
    makeScenario({
      hour: (h) => ({ demand_kwh: 100, solar_kwh: 0, tariff_bdt_per_kwh: h + 1 }),
      battery: { ...TOY_BATTERY, capacity_kwh: 200, minimum_energy_kwh: 200 },
    }),
  );
  assert.ok(body.hourly_plan.every((p) => p.battery_energy_after_kwh === 200));
});

test("grid cap 0 all day, covered by solar + battery", async () => {
  const sc = makeScenario({
    notes: 1,
    hour: (h) => ({ demand_kwh: 50, solar_kwh: h >= 6 && h < 18 ? 150 : 0, tariff_bdt_per_kwh: 8 }),
    battery: {
      capacity_kwh: 1000,
      initial_energy_kwh: 600,
      minimum_energy_kwh: 0,
      max_charge_kwh_per_hour: 100,
      max_discharge_kwh_per_hour: 100,
    },
  });
  const body = await solve(sc, [directive(0, "max_grid_window", { hours: ALL, max_grid_kwh: 0 })]);
  assert.equal(body.total_grid_kwh, 0);
});

test("no-charge and no-discharge over all 24 hours -> idle", async () => {
  const sc = makeScenario({ notes: 2, hour: (h) => flat(100, 0, h + 1)(), battery: TOY_BATTERY });
  const body = await solve(sc, [
    directive(0, "no_charge_window", { hours: ALL }),
    directive(1, "no_discharge_window", { hours: ALL }),
  ]);
  assert.ok(body.hourly_plan.every((p) => p.battery_action === "idle"));
});

test("reserve equal to capacity at a single hour forces a full charge", async () => {
  const sc = makeScenario({
    hour: (h) => ({ demand_kwh: 100, solar_kwh: 0, tariff_bdt_per_kwh: 10 - (h % 5) }),
    battery: TOY_BATTERY,
  });
  const body = await solve(sc, [directive(0, "minimum_battery_reserve", { hours: [8], minimum_energy_kwh: 500 })]);
  assert.equal(body.hourly_plan[8].battery_energy_after_kwh, 500);
});

test("three overlapping directives of different types on the same hours", async () => {
  const sc = makeScenario({
    notes: 3,
    hour: (h) => ({ demand_kwh: 120, solar_kwh: h >= 10 && h < 15 ? 200 : 0, tariff_bdt_per_kwh: h >= 17 ? 15 : 6 }),
    battery: TOY_BATTERY,
  });
  const hours = range(17, 21);
  const body = await solve(sc, [
    directive(0, "minimum_battery_reserve", { hours, minimum_energy_kwh: 150 }),
    directive(1, "max_grid_window", { hours, max_grid_kwh: 60 }),
    directive(2, "no_charge_window", { hours }),
  ]);
  for (const h of hours) {
    const p = body.hourly_plan[h];
    assert.ok(p.battery_energy_after_kwh >= 150 - TOL && p.grid_kwh <= 60 + TOL && p.battery_action !== "charge");
  }
});

test("duplicate directives of the same type take the strictest value", async () => {
  const sc = makeScenario({ notes: 3, hour: (h) => flat(100, 0, h < 12 ? 5 : 10)(), battery: TOY_BATTERY });
  const body = await solve(sc, [
    directive(0, "max_grid_window", { hours: [18, 19], max_grid_kwh: 80 }),
    directive(1, "max_grid_window", { hours: [19, 20], max_grid_kwh: 40 }),
    directive(2, "minimum_battery_reserve", { hours: [19], minimum_energy_kwh: 60 }),
  ]);
  assert.ok(body.hourly_plan[18].grid_kwh <= 80 + TOL);
  assert.ok(body.hourly_plan[19].grid_kwh <= 40 + TOL);
  assert.ok(body.hourly_plan[20].grid_kwh <= 40 + TOL);
});

test("solar factor 0 on every hour removes all solar", async () => {
  const sc = makeScenario({ hour: flat(100, 300, 7), battery: TOY_BATTERY });
  const body = await solve(sc, [directive(0, "solar_reduction", { hours: ALL, factor: 0 })]);
  assert.ok(body.hourly_plan.every((p) => p.solar_used_kwh === 0));
  assert.ok(near(body.total_cost_bdt, 24 * 100 * 7));
});

test("reserve above initial on hour 23 is infeasible -> 422", async () => {
  const sc = makeScenario({ hour: flat(100, 0, 5), battery: TOY_BATTERY });
  await assert.rejects(
    solve(sc, [directive(0, "minimum_battery_reserve", { hours: [23], minimum_energy_kwh: 300 })]),
    (err) => err.status === 422,
  );
});

test("demand larger than grid cap + battery rate -> 422", async () => {
  const sc = makeScenario({ hour: flat(500, 0, 5), battery: TOY_BATTERY });
  await assert.rejects(
    solve(sc, [directive(0, "max_grid_window", { hours: [12], max_grid_kwh: 100 })]),
    (err) => err.status === 422,
  );
});

test("solver recovers after a solver-level failure", async () => {
  const sc = makeScenario({ hour: flat(100, 0, 5), battery: TOY_BATTERY });
  const broken = { ...sc, hours: sc.hours.map((x) => ({ ...x, demand_kwh: 1e25 })) };
  await assert.rejects(optimize(broken, buildLimits(broken, [noOp(0)])));
  const body = await solve(sc);
  assert.ok(near(body.total_cost_bdt, 12000));
});
