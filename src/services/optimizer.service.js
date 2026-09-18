const highsLoader = require("highs");
const { HOURS } = require("../constants");
const { r6 } = require("../utils/number");

let highsPromise = null;
const getHighs = () => (highsPromise ??= highsLoader());

const f6 = (x) => x.toFixed(6);
const term = (c, name) => `${c < 0 ? "-" : "+"} ${f6(Math.abs(c))} ${name}`;

function buildLp(sc, lim) {
  const b = sc.battery;
  const last = HOURS - 1;
  const lines = ["Minimize", " obj:"];
  for (let h = 0; h < HOURS; h++) lines.push(`  ${term(sc.hours[h].tariff_bdt_per_kwh, `grid${h}`)}`);
  lines.push("Subject To");
  for (let h = 0; h < HOURS; h++) {
    lines.push(` bal${h}: grid${h} + sol${h} + dis${h} - chg${h} = ${f6(sc.hours[h].demand_kwh)}`);
    lines.push(
      h === 0
        ? ` soc_t0: soc0 - chg0 + dis0 = ${f6(b.initial_energy_kwh)}`
        : ` soc_t${h}: soc${h} - soc${h - 1} - chg${h} + dis${h} = 0`,
    );
  }
  lines.push(` neutral: soc${last} = ${f6(b.initial_energy_kwh)}`);
  lines.push("Bounds");
  for (let h = 0; h < HOURS; h++) {
    lines.push(` 0 <= sol${h} <= ${f6(lim.effSolar[h])}`);
    lines.push(` 0 <= chg${h} <= ${f6(lim.maxCharge[h])}`);
    lines.push(` 0 <= dis${h} <= ${f6(lim.maxDischarge[h])}`);
    lines.push(` ${f6(lim.minSoc[h])} <= soc${h} <= ${f6(b.capacity_kwh)}`);
    lines.push(Number.isFinite(lim.maxGrid[h]) ? ` 0 <= grid${h} <= ${f6(lim.maxGrid[h])}` : ` grid${h} >= 0`);
  }
  lines.push("End");
  return lines.join("\n");
}

async function solveLp(lp) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await getHighs()).solve(lp);
    } catch {
      highsPromise = null;
      if (attempt >= 1) throw new Error("solver_error");
    }
  }
}

async function optimize(sc, lim) {
  const res = await solveLp(buildLp(sc, lim));
  if (res.Status !== "Optimal") return { ok: false, status: res.Status };
  const value = (name) => res.Columns[name].Primal;

  let soc = sc.battery.initial_energy_kwh;
  const plan = [];
  for (let h = 0; h < HOURS; h++) {
    const net = value(`chg${h}`) - value(`dis${h}`);
    let action = "idle";
    let kwh = 0;
    if (net > 1e-6) {
      action = "charge";
      kwh = r6(net);
    } else if (net < -1e-6) {
      action = "discharge";
      kwh = r6(-net);
    }
    const chg = action === "charge" ? kwh : 0;
    const dis = action === "discharge" ? kwh : 0;
    const solar = r6(Math.min(Math.max(value(`sol${h}`), 0), lim.effSolar[h]));
    const grid = r6(Math.max(0, sc.hours[h].demand_kwh + chg - dis - solar));
    soc = r6(soc + chg - dis);
    plan.push({
      hour: h,
      grid_kwh: grid,
      solar_used_kwh: solar,
      battery_action: action,
      battery_kwh: kwh,
      battery_energy_after_kwh: soc,
    });
  }
  return { ok: true, plan };
}

async function warmUp() {
  try {
    (await getHighs()).solve("Minimize\n obj: + 1 x\nSubject To\n c: x >= 1\nEnd");
  } catch {
    highsPromise = null;
  }
}

module.exports = { optimize, buildLp, warmUp };
