const test = require("node:test");
const assert = require("node:assert/strict");
const { planFromInterpretations } = require("../src/services/energy.service");
const { range, makeScenario, noOp, directive, seededRandom } = require("./helpers");

const CASES = 1500;

function oracleLimits(sc, interps) {
  const b = sc.battery;
  const lim = {
    solar: sc.hours.map((x) => x.solar_kwh),
    minSoc: Array(24).fill(b.minimum_energy_kwh),
    maxChg: Array(24).fill(b.max_charge_kwh_per_hour),
    maxDis: Array(24).fill(b.max_discharge_kwh_per_hour),
    maxGrid: Array(24).fill(Infinity),
  };
  for (const it of interps.filter((x) => x.applies)) {
    const a = it.structured_adjustment;
    for (const h of a.hours) {
      if (it.directive_type === "solar_reduction") lim.solar[h] *= a.factor;
      if (it.directive_type === "minimum_battery_reserve")
        lim.minSoc[h] = Math.max(lim.minSoc[h], a.minimum_energy_kwh);
      if (it.directive_type === "no_charge_window") lim.maxChg[h] = 0;
      if (it.directive_type === "no_discharge_window") lim.maxDis[h] = 0;
      if (it.directive_type === "max_grid_window") lim.maxGrid[h] = Math.min(lim.maxGrid[h], a.max_grid_kwh);
    }
  }
  return lim;
}

function oracleOptimalCost(sc, interps) {
  const b = sc.battery;
  const lim = oracleLimits(sc, interps);
  let cost = Array(b.capacity_kwh + 1).fill(Infinity);
  cost[b.initial_energy_kwh] = 0;
  for (let h = 0; h < 24; h++) {
    const next = Array(b.capacity_kwh + 1).fill(Infinity);
    const { demand_kwh, tariff_bdt_per_kwh } = sc.hours[h];
    for (let s = 0; s <= b.capacity_kwh; s++) {
      if (cost[s] === Infinity) continue;
      for (let net = -lim.maxDis[h]; net <= lim.maxChg[h]; net++) {
        const s2 = s + net;
        if (s2 < lim.minSoc[h] || s2 > b.capacity_kwh) continue;
        const grid = Math.max(0, demand_kwh + net - lim.solar[h]);
        if (grid > lim.maxGrid[h]) continue;
        const c = cost[s] + grid * tariff_bdt_per_kwh;
        if (c < next[s2]) next[s2] = c;
      }
    }
    cost = next;
  }
  return cost[b.initial_energy_kwh];
}

function randomHours(rng) {
  if (rng.next() < 0.7) {
    const start = rng.int(0, 23);
    return range(start, rng.int(start + 1, 24));
  }
  const set = new Set(Array.from({ length: rng.int(1, 8) }, () => rng.int(0, 23)));
  return [...set].sort((a, b) => a - b);
}

function randomInterp(rng, i, capacity) {
  const hours = randomHours(rng);
  switch (rng.int(0, 5)) {
    case 0:
      return directive(i, "solar_reduction", { hours, factor: rng.pick([0, 0.25, 0.5, 0.75, 1]) });
    case 1:
      return directive(i, "minimum_battery_reserve", { hours, minimum_energy_kwh: rng.int(0, capacity) });
    case 2:
      return directive(i, "no_charge_window", { hours });
    case 3:
      return directive(i, "no_discharge_window", { hours });
    case 4:
      return directive(i, "max_grid_window", { hours, max_grid_kwh: rng.int(0, 200) });
    default:
      return noOp(i);
  }
}

function randomCase(rng, id) {
  const capacity = rng.int(0, 80);
  const minimum = rng.int(0, capacity);
  const notes = rng.int(1, 3);
  const sc = makeScenario({
    id,
    notes,
    hour: (h) => ({
      demand_kwh: rng.int(0, 150),
      solar_kwh: h >= 6 && h <= 18 ? rng.pick([0, 64, 128, 192]) : rng.pick([0, 0, 0, 64]),
      tariff_bdt_per_kwh: rng.int(0, 20),
    }),
    battery: {
      capacity_kwh: capacity,
      initial_energy_kwh: rng.int(minimum, capacity),
      minimum_energy_kwh: minimum,
      max_charge_kwh_per_hour: rng.int(0, 40),
      max_discharge_kwh_per_hour: rng.int(0, 40),
    },
  });
  const interps = range(0, notes).map((i) => randomInterp(rng, i, capacity));
  return { sc, interps };
}

test(`LP optimum equals independent DP oracle on ${CASES} random scenarios`, async () => {
  const rng = seededRandom(20260918);
  let feasible = 0;
  let infeasible = 0;
  for (let k = 0; k < CASES; k++) {
    const { sc, interps } = randomCase(rng, `FUZZ-${k}`);
    const expected = oracleOptimalCost(sc, interps);
    let body = null;
    try {
      body = await planFromInterpretations(sc, interps);
    } catch (err) {
      assert.equal(err.status, 422, `FUZZ-${k}: unexpected ${err.status} ${err.message}`);
    }
    if (expected === Infinity) {
      assert.equal(body, null, `FUZZ-${k}: oracle infeasible but LP returned cost ${body?.total_cost_bdt}`);
      infeasible++;
    } else {
      assert.ok(body, `FUZZ-${k}: oracle cost ${expected} but LP reported infeasible`);
      assert.ok(
        Math.abs(body.total_cost_bdt - expected) <= 0.01,
        `FUZZ-${k}: oracle ${expected} vs LP ${body.total_cost_bdt}`,
      );
      feasible++;
    }
  }
  assert.ok(feasible > CASES * 0.2, `too few feasible cases: ${feasible}`);
  assert.ok(infeasible > 0, "no infeasible cases generated");
  console.log(`fuzz: ${feasible} feasible matched oracle, ${infeasible} infeasible matched oracle`);
});
