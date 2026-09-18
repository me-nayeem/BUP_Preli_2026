const { validateScenario } = require("../src/validators/scenario.validator");

const range = (start, end) => Array.from({ length: end - start }, (_, k) => start + k);

function makeScenario({ id = "TEST", notes = 1, hour, battery }) {
  const result = validateScenario({
    scenario_id: id,
    operator_notes: Array.from({ length: notes }, (_, i) => `note ${i}`),
    hours: range(0, 24).map((h) => ({ hour: h, ...hour(h) })),
    battery,
  });
  if (!result.ok) throw new Error(result.error);
  return result.scenario;
}

const TOY_BATTERY = {
  capacity_kwh: 500,
  initial_energy_kwh: 200,
  minimum_energy_kwh: 50,
  max_charge_kwh_per_hour: 100,
  max_discharge_kwh_per_hour: 100,
};

const toyScenario = ({ notes = 1, solarAt = {} } = {}) =>
  makeScenario({
    id: "TOY",
    notes,
    hour: (h) => ({ demand_kwh: 100, solar_kwh: solarAt[h] ?? 0, tariff_bdt_per_kwh: h < 12 ? 5 : 10 }),
    battery: TOY_BATTERY,
  });

const noOp = (i) => ({
  note_index: i,
  applies: false,
  directive_type: "no_op",
  structured_adjustment: null,
  explanation: "test",
});

const directive = (i, type, adjustment) => ({
  note_index: i,
  applies: true,
  directive_type: type,
  structured_adjustment: adjustment,
  explanation: "test",
});

function seededRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  return { next, int, pick };
}

async function startServer(app) {
  const server = app.listen(0, "127.0.0.1", 1024);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

module.exports = { range, makeScenario, toyScenario, TOY_BATTERY, noOp, directive, seededRandom, startServer };
