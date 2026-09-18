const { HOURS, BATTERY_FIELDS, MAX_ABS_VALUE } = require("../constants");
const { isFiniteNumber } = require("../utils/number");

function validateScenario(body) {
  const bad = (error) => ({ ok: false, status: 400, error });
  const sem = (error) => ({ ok: false, status: 422, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("body must be a JSON object");
  const { scenario_id, operator_notes, hours, battery } = body;
  if (typeof scenario_id !== "string" || !scenario_id.trim()) return bad("scenario_id must be a non-empty string");
  if (!Array.isArray(operator_notes) || operator_notes.length < 1 || operator_notes.length > 3)
    return bad("operator_notes must contain 1-3 items");
  if (!operator_notes.every((n) => typeof n === "string" && n.trim()))
    return bad("operator_notes must be non-empty strings");
  if (!Array.isArray(hours) || hours.length !== HOURS) return bad("hours must contain exactly 24 entries");
  const byHour = new Array(HOURS);
  for (const e of hours) {
    if (!e || typeof e !== "object" || !Number.isInteger(e.hour) || e.hour < 0 || e.hour >= HOURS)
      return bad("each hour entry needs an integer hour 0-23");
    if (byHour[e.hour]) return bad(`duplicate hour ${e.hour}`);
    if (!isFiniteNumber(e.demand_kwh) || !isFiniteNumber(e.solar_kwh) || !isFiniteNumber(e.tariff_bdt_per_kwh))
      return bad(`hour ${e.hour}: demand_kwh, solar_kwh, tariff_bdt_per_kwh must be numbers`);
    byHour[e.hour] = e;
  }
  if (
    !battery ||
    typeof battery !== "object" ||
    Array.isArray(battery) ||
    !BATTERY_FIELDS.every((k) => isFiniteNumber(battery[k]))
  )
    return bad("battery fields must all be finite numbers");
  const values = [
    ...byHour.flatMap((e) => [e.demand_kwh, e.solar_kwh, e.tariff_bdt_per_kwh]),
    ...BATTERY_FIELDS.map((k) => battery[k]),
  ];
  if (values.some((x) => Math.abs(x) > MAX_ABS_VALUE)) return sem(`numeric values must be within +/-${MAX_ABS_VALUE}`);
  if (byHour.some((e) => e.demand_kwh < 0 || e.solar_kwh < 0)) return sem("demand and solar must be non-negative");
  if (
    BATTERY_FIELDS.some((k) => battery[k] < 0) ||
    battery.minimum_energy_kwh > battery.capacity_kwh ||
    battery.initial_energy_kwh < battery.minimum_energy_kwh ||
    battery.initial_energy_kwh > battery.capacity_kwh
  )
    return sem("inconsistent battery parameters");
  return { ok: true, scenario: { scenario_id, operator_notes, hours: byHour, battery } };
}

module.exports = { validateScenario };
