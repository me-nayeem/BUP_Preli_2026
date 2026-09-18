const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const B = ["capacity_kwh", "initial_energy_kwh", "minimum_energy_kwh",
           "max_charge_kwh_per_hour", "max_discharge_kwh_per_hour"];

// Structural problems -> 400, well-formed but semantically impossible -> 422.
// Unknown extra fields are ignored on purpose so a valid judge case is never rejected.
function validateRequest(body) {
  const bad = (error) => ({ ok: false, status: 400, error });
  const sem = (error) => ({ ok: false, status: 422, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("body must be a JSON object");
  const { scenario_id, operator_notes, hours, battery } = body;
  if (typeof scenario_id !== "string" || !scenario_id.trim()) return bad("scenario_id must be a non-empty string");
  if (!Array.isArray(operator_notes) || operator_notes.length < 1 || operator_notes.length > 3)
    return bad("operator_notes must contain 1-3 items");
  if (!operator_notes.every((n) => typeof n === "string" && n.trim())) return bad("operator_notes must be non-empty strings");
  if (!Array.isArray(hours) || hours.length !== 24) return bad("hours must contain exactly 24 entries");
  const byHour = new Array(24);
  for (const e of hours) {
    if (!e || typeof e !== "object" || !Number.isInteger(e.hour) || e.hour < 0 || e.hour > 23)
      return bad("each hour entry needs an integer hour 0-23");
    if (byHour[e.hour]) return bad(`duplicate hour ${e.hour}`);
    if (!isNum(e.demand_kwh) || !isNum(e.solar_kwh) || !isNum(e.tariff_bdt_per_kwh))
      return bad(`hour ${e.hour}: demand_kwh, solar_kwh, tariff_bdt_per_kwh must be numbers`);
    byHour[e.hour] = e;
  }
  if (!battery || typeof battery !== "object" || Array.isArray(battery) || !B.every((k) => isNum(battery[k])))
    return bad("battery fields must all be finite numbers");
  if (byHour.some((e) => e.demand_kwh < 0 || e.solar_kwh < 0)) return sem("demand and solar must be non-negative");
  if (B.some((k) => battery[k] < 0) || battery.minimum_energy_kwh > battery.capacity_kwh ||
      battery.initial_energy_kwh < battery.minimum_energy_kwh || battery.initial_energy_kwh > battery.capacity_kwh)
    return sem("inconsistent battery parameters");
  return { ok: true, scenario: { scenario_id, operator_notes, hours: byHour, battery } };
}

module.exports = { validateRequest };
