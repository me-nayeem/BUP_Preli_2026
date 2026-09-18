try {
  process.loadEnvFile();
} catch {}

const { interpretAll, clearCache } = require("../../src/services/interpreter.service");
const config = require("../../src/config");

const BATTERY = { capacity_kwh: 500 };
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 4000);
const REPEAT = Number(process.argv.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? 1);
const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

const CASES = [
  ["PV production will drop to about 20% between 13:00 and 15:00.", "solar_reduction", [13, 14], 0.2],
  [
    "Panel washing from one until three will leave roughly one-fifth of normal solar output.",
    "solar_reduction",
    [13, 14],
    0.2,
  ],
  ["Expect an 80% reduction in rooftop solar during the 1-3 PM maintenance window.", "solar_reduction", [13, 14], 0.2],
  ["Solar generation will be cut by 30% from 10 AM to noon.", "solar_reduction", [10, 11], 0.7],
  ["Rooftop arrays are fully offline from 11:00 to 13:00.", "solar_reduction", [11, 12], 0],
  [
    "Dust storm expected: solar yield only 40 percent of forecast from 9 AM till 1 PM.",
    "solar_reduction",
    [9, 10, 11, 12],
    0.4,
  ],
  ["An inverter firmware update at 2 PM will knock out solar for one hour.", "solar_reduction", [14], 0],
  [
    "Partial shading from the new building halves PV output between 3 and 5 in the afternoon.",
    "solar_reduction",
    [15, 16],
    0.5,
  ],
  ["Lower the solar forecast by a quarter for 8 AM through 11 AM.", "solar_reduction", [8, 9, 10], 0.75],
  [
    "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.",
    "solar_reduction",
    [12, 13],
    0.25,
  ],
  ["Don't let the battery fall below 150 kWh between 7 and 10 PM.", "minimum_battery_reserve", [19, 20, 21], 150],
  ["Maintain a 40% state of charge from 5 PM to 8 PM.", "minimum_battery_reserve", [17, 18, 19], 200],
  ["Keep at least 100 kWh in the battery all day.", "minimum_battery_reserve", range(0, 24), 100],
  [
    "The data center requires at least 80 kWh to remain in the battery from 6 PM until 10 PM.",
    "minimum_battery_reserve",
    [18, 19, 20, 21],
    80,
  ],
  [
    "Keep at least 50% of the battery capacity stored in the battery from 6 PM until 9 PM for emergency operations.",
    "minimum_battery_reserve",
    [18, 19, 20],
    250,
  ],
  [
    "Emergency lighting needs the battery kept half full from 20:00 to midnight.",
    "minimum_battery_reserve",
    [20, 21, 22, 23],
    250,
  ],
  ["Reserve 0.12 MWh in storage between 4 and 6 PM.", "minimum_battery_reserve", [16, 17], 120],
  ["Battery charging is disabled from 3 PM to 5 PM for a BMS update.", "no_charge_window", [15, 16]],
  ["Do not charge the battery from midnight to 2 AM.", "no_charge_window", [0, 1]],
  [
    "The battery charger will be isolated from 2 AM until 5 AM for electrical maintenance.",
    "no_charge_window",
    [2, 3, 4],
  ],
  ["Charging is prohibited at 9 AM while the breaker is tested.", "no_charge_window", [9]],
  ["No battery charging after 9 PM tonight.", "no_charge_window", [21, 22, 23]],
  ["The battery must not discharge during the 6 PM hour.", "no_discharge_window", [18]],
  ["For three hours starting at 7 PM, do not draw from the battery.", "no_discharge_window", [19, 20, 21]],
  ["For protection testing, the battery must not discharge from 6 PM until 8 PM.", "no_discharge_window", [18, 19]],
  ["Relay testing: battery output must stay off between 16:00 and 18:00.", "no_discharge_window", [16, 17]],
  ["The battery cannot be used to supply the campus from 11 PM to 1 AM.", "no_discharge_window", [0, 23]],
  ["Keep grid draw at or below 150 kWh each hour from 17:00 to 20:00.", "max_grid_window", [17, 18, 19], 150],
  ["The feeder can supply at most 0.2 MWh per hour between 6 and 8 PM.", "max_grid_window", [18, 19], 200],
  ["No grid import from 11 PM until midnight.", "max_grid_window", [23], 0],
  [
    "From 6 PM until 9 PM, campus grid import must not exceed 155 kWh in any hour because the feeder is operating under a temporary limit.",
    "max_grid_window",
    [18, 19, 20],
    155,
  ],
  [
    "The utility asked us to limit demand from the grid to 120 kW between 1 and 4 PM.",
    "max_grid_window",
    [13, 14, 15],
    120,
  ],
  ["Planned grid outage 3 AM to 5 AM.", "max_grid_window", [3, 4], 0],
  ["The PV array was inspected yesterday and found in good condition.", "no_op"],
  ["The electricity tariff will be revised next month.", "no_op"],
  ["Library hours are extended until 10 PM.", "no_op"],
  ["Expect heavier air-conditioning load than usual this evening.", "no_op"],
  ["The sports office moved next month's registration deadline.", "no_op"],
  ["A new 500 kWh battery bank will be installed next quarter.", "no_op"],
  ["Next Tuesday the solar panels will be cleaned from 10 AM to noon.", "no_op"],
  ["The energy audit report was submitted to the registrar.", "no_op"],
  ["Grid tariff is higher between 6 and 10 PM as usual.", "no_op"],
];

const VALUE_KEY = {
  solar_reduction: "factor",
  minimum_battery_reserve: "minimum_energy_kwh",
  max_grid_window: "max_grid_kwh",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function score(got, [, type, hours, value]) {
  const typeOk = got.directive_type === type;
  const hoursOk =
    type === "no_op"
      ? got.structured_adjustment === null
      : JSON.stringify(got.structured_adjustment?.hours) === JSON.stringify(hours);
  const key = VALUE_KEY[type];
  const valueOk = !key || Math.abs((got.structured_adjustment?.[key] ?? NaN) - value) <= 0.01;
  return { typeOk, hoursOk, valueOk, all: typeOk && hoursOk && valueOk };
}

async function runOnce(pass) {
  clearCache();
  const tally = { type: 0, hours: 0, value: 0, all: 0 };
  const misses = [];
  const latencies = [];
  for (let start = 0; start < CASES.length; start += 3) {
    const batch = CASES.slice(start, start + 3);
    const t = Date.now();
    const out = await interpretAll(
      batch.map((c) => c[0]),
      BATTERY,
    );
    latencies.push(Date.now() - t);
    batch.forEach((c, k) => {
      const s = score(out[k], c);
      tally.type += s.typeOk;
      tally.hours += s.hoursOk;
      tally.value += s.valueOk;
      tally.all += s.all;
      if (!s.all)
        misses.push(
          `  MISS "${c[0]}"\n    expected ${c[1]} ${JSON.stringify(c[2] ?? null)} ${c[3] ?? ""}\n    got      ${out[k].directive_type} ${JSON.stringify(out[k].structured_adjustment)}`,
        );
    });
    if (start + 3 < CASES.length) await sleep(DELAY_MS);
  }
  const n = CASES.length;
  const pct = (x) => `${((100 * x) / n).toFixed(1)}%`;
  console.log(
    `\npass ${pass}: exact ${tally.all}/${n} (${pct(tally.all)}) | type ${pct(tally.type)} | hours ${pct(tally.hours)} | value ${pct(tally.value)}`,
  );
  console.log(`batch latency ms: ${latencies.join(", ")}`);
  if (misses.length) console.log(misses.join("\n"));
  return tally.all;
}

(async () => {
  if (!config.llm.providers.length) {
    console.error("No LLM configured: set LLM_API_KEY and LLM_MODEL in .env");
    process.exit(1);
  }
  console.log(`providers: ${config.llm.providers.map((p) => `${p.label}=${p.model}`).join(", ")}`);
  const scores = [];
  for (let pass = 1; pass <= REPEAT; pass++) scores.push(await runOnce(pass));
  if (REPEAT > 1 && new Set(scores).size > 1) console.log("\nWARNING: results differ between passes");
})();
