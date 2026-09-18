const { HOURS } = require("../constants");

function buildLimits(sc, interps) {
  const b = sc.battery;
  const lim = {
    effSolar: sc.hours.map((x) => x.solar_kwh),
    minSoc: Array(HOURS).fill(b.minimum_energy_kwh),
    maxCharge: Array(HOURS).fill(b.max_charge_kwh_per_hour),
    maxDischarge: Array(HOURS).fill(b.max_discharge_kwh_per_hour),
    maxGrid: Array(HOURS).fill(Infinity),
  };
  for (const it of interps) {
    if (!it.applies) continue;
    const a = it.structured_adjustment;
    for (const h of a.hours) {
      switch (it.directive_type) {
        case "solar_reduction":
          lim.effSolar[h] *= a.factor;
          break;
        case "minimum_battery_reserve":
          lim.minSoc[h] = Math.max(lim.minSoc[h], a.minimum_energy_kwh);
          break;
        case "no_charge_window":
          lim.maxCharge[h] = 0;
          break;
        case "no_discharge_window":
          lim.maxDischarge[h] = 0;
          break;
        case "max_grid_window":
          lim.maxGrid[h] = Math.min(lim.maxGrid[h], a.max_grid_kwh);
          break;
      }
    }
  }
  return lim;
}

module.exports = { buildLimits };
