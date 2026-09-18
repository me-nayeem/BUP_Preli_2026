const { HOURS, DIRECTIVE_TYPES, BATTERY_ACTIONS, REPLAY_TOLERANCE: T } = require("../constants");

function checkInterpretations(sc, interps, errs) {
  if (interps.length !== sc.operator_notes.length || interps.some((it, i) => it.note_index !== i))
    errs.push("directive_interpretation count/order");
  interps.forEach((it, i) => {
    if (!DIRECTIVE_TYPES.includes(it.directive_type)) errs.push(`note ${i}: unsupported directive_type`);
    if (it.directive_type === "no_op") {
      if (it.applies !== false || it.structured_adjustment !== null) errs.push(`note ${i}: no_op semantics`);
      return;
    }
    const hours = it.structured_adjustment?.hours;
    if (it.applies !== true || !Array.isArray(hours) || hours.length === 0) {
      errs.push(`note ${i}: directive semantics`);
      return;
    }
    if (!hours.every((h, k) => Number.isInteger(h) && h >= 0 && h < HOURS && (k === 0 || h > hours[k - 1])))
      errs.push(`note ${i}: hours must be unique ascending integers 0-23`);
  });
}

function checkPlan(sc, plan, errs) {
  const b = sc.battery;
  let soc = b.initial_energy_kwh;
  plan.forEach((p, h) => {
    const d = sc.hours[h];
    if (p.hour !== h) errs.push(`h${h}: wrong hour`);
    for (const k of ["grid_kwh", "solar_used_kwh", "battery_kwh", "battery_energy_after_kwh"])
      if (!Number.isFinite(p[k]) || p[k] < 0) errs.push(`h${h}: ${k} not finite/non-negative`);
    if (!BATTERY_ACTIONS.includes(p.battery_action)) errs.push(`h${h}: bad action`);
    const chg = p.battery_action === "charge" ? p.battery_kwh : 0;
    const dis = p.battery_action === "discharge" ? p.battery_kwh : 0;
    if (p.battery_action === "idle" && p.battery_kwh !== 0) errs.push(`h${h}: idle needs battery_kwh 0`);
    if (chg > b.max_charge_kwh_per_hour + T || dis > b.max_discharge_kwh_per_hour + T) errs.push(`h${h}: rate limit`);
    if (Math.abs(p.grid_kwh + p.solar_used_kwh + dis - d.demand_kwh - chg) > T) errs.push(`h${h}: energy balance`);
    soc += chg - dis;
    if (Math.abs(soc - p.battery_energy_after_kwh) > T) errs.push(`h${h}: battery transition`);
    if (p.battery_energy_after_kwh < b.minimum_energy_kwh - T || p.battery_energy_after_kwh > b.capacity_kwh + T)
      errs.push(`h${h}: battery bounds`);
  });
  if (Math.abs(plan[HOURS - 1].battery_energy_after_kwh - b.initial_energy_kwh) > T) errs.push("end-of-day neutrality");
}

function checkDirectives(sc, interps, plan, errs) {
  const factor = Array(HOURS).fill(1);
  for (const it of interps) {
    if (!it.applies) continue;
    const a = it.structured_adjustment;
    for (const h of a.hours) {
      const p = plan[h];
      switch (it.directive_type) {
        case "solar_reduction":
          factor[h] *= a.factor;
          break;
        case "minimum_battery_reserve":
          if (p.battery_energy_after_kwh < a.minimum_energy_kwh - T) errs.push(`h${h}: reserve`);
          break;
        case "no_charge_window":
          if (p.battery_action === "charge") errs.push(`h${h}: no_charge`);
          break;
        case "no_discharge_window":
          if (p.battery_action === "discharge") errs.push(`h${h}: no_discharge`);
          break;
        case "max_grid_window":
          if (p.grid_kwh > a.max_grid_kwh + T) errs.push(`h${h}: grid cap`);
          break;
      }
    }
  }
  plan.forEach((p, h) => {
    if (p.solar_used_kwh > sc.hours[h].solar_kwh * factor[h] + T) errs.push(`h${h}: effective solar`);
  });
}

function checkTotals(sc, body, errs) {
  const plan = body.hourly_plan;
  const grid = plan.reduce((s, p) => s + p.grid_kwh, 0);
  const cost = plan.reduce((s, p, h) => s + p.grid_kwh * sc.hours[h].tariff_bdt_per_kwh, 0);
  const peak = Math.max(...plan.map((p) => p.grid_kwh));
  if (Math.abs(grid - body.total_grid_kwh) > T) errs.push("total_grid_kwh mismatch");
  if (Math.abs(cost - body.total_cost_bdt) > T) errs.push("total_cost_bdt mismatch");
  if (Math.abs(peak - body.peak_grid_kwh) > T) errs.push("peak_grid_kwh mismatch");
}

function replay(sc, interps, body) {
  const errs = [];
  checkInterpretations(sc, interps, errs);
  const plan = body.hourly_plan;
  if (!Array.isArray(plan) || plan.length !== HOURS) return [...errs, "hourly_plan must have 24 entries"];
  checkPlan(sc, plan, errs);
  if (errs.some((e) => e.startsWith("note"))) return errs;
  checkDirectives(sc, interps, plan, errs);
  checkTotals(sc, body, errs);
  return errs;
}

module.exports = { replay };
