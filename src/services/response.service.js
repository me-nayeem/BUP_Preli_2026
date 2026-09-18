const { r6 } = require("../utils/number");

function buildPlanSummary(interps, plan, totalCost, peakGrid) {
  const applied = interps.filter((i) => i.applies).map((i) => i.directive_type);
  const ch = plan.filter((p) => p.battery_action === "charge").map((p) => p.hour);
  const dis = plan.filter((p) => p.battery_action === "discharge").map((p) => p.hour);
  return (
    `Applied ${applied.length} directive(s)${applied.length ? ` (${applied.join(", ")})` : ""}; ` +
    `${interps.length - applied.length} note(s) treated as no_op. Battery charges in hours [${ch}] ` +
    `and discharges in hours [${dis}], ending at its starting level. ` +
    `Total grid cost ${totalCost.toFixed(2)} BDT, peak grid ${peakGrid.toFixed(2)} kWh.`
  );
}

function buildResponse(sc, interps, plan) {
  const total_grid_kwh = r6(plan.reduce((a, p) => a + p.grid_kwh, 0));
  const total_cost_bdt = r6(plan.reduce((a, p, h) => a + p.grid_kwh * sc.hours[h].tariff_bdt_per_kwh, 0));
  const peak_grid_kwh = Math.max(...plan.map((p) => p.grid_kwh));
  return {
    scenario_id: sc.scenario_id,
    directive_interpretation: interps,
    hourly_plan: plan,
    total_grid_kwh,
    total_cost_bdt,
    peak_grid_kwh,
    plan_summary: buildPlanSummary(interps, plan, total_cost_bdt, peak_grid_kwh),
  };
}

module.exports = { buildResponse };
