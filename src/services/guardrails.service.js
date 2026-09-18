const { DIRECTIVE_TYPES, HOURS } = require("../constants");
const { r6 } = require("../utils/number");

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

function toNumber(x) {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x.trim().replace(/%$/, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseBatch(text, count) {
  const parsed = parseJson(text);
  let items = Array.isArray(parsed) ? parsed : (parsed?.results ?? parsed?.notes ?? parsed?.interpretations);
  if (!items && count === 1 && parsed && typeof parsed === "object" && "directive_type" in parsed) items = [parsed];
  if (!Array.isArray(items)) return fail('reply must be one JSON object of the form {"results":[...]}');
  if (items.length !== count) return fail(`results must contain exactly ${count} item(s), one per note, in order`);
  const indexes = items.map((it) => toNumber(it?.index));
  if (indexes.every(Number.isInteger)) {
    const sorted = [...indexes].sort((a, b) => a - b);
    if (!sorted.every((v, k) => v === k)) return fail(`index values must be exactly 0..${count - 1}`);
    items = sorted.map((k) => items[indexes.indexOf(k)]);
  }
  return ok(items);
}

function expandWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0)
    return fail("windows must be a non-empty array for this directive");
  const set = new Set();
  for (const w of windows) {
    const start = toNumber(w?.start_hour);
    let end = toNumber(w?.end_hour);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return fail("start_hour and end_hour must be integers");
    if (end === 0 && start > 0) end = HOURS;
    if (start < 0 || end > HOURS || end <= start)
      return fail(
        `window [${start},${end}) is invalid: need 0 <= start_hour < end_hour <= 24; split windows that cross midnight`,
      );
    for (let h = start; h < end; h++) set.add(h);
  }
  return ok([...set].sort((a, b) => a - b));
}

function resolveHours(raw) {
  if (Array.isArray(raw.windows) && raw.windows.length) return expandWindows(raw.windows);
  if (Array.isArray(raw.hours) && raw.hours.length) {
    const hours = raw.hours.map(toNumber);
    if (!hours.every((h) => Number.isInteger(h) && h >= 0 && h < HOURS)) return fail("hours must be integers 0-23");
    return ok([...new Set(hours)].sort((a, b) => a - b));
  }
  return expandWindows(raw.windows);
}

function solarFactor(raw) {
  const remaining = toNumber(raw.remaining_percent);
  const reduction = toNumber(raw.reduction_percent);
  if (remaining === null && reduction === null) {
    const factor = toNumber(raw.factor);
    if (factor !== null && factor >= 0 && factor <= 1) return ok(r6(factor));
    return fail("solar_reduction needs remaining_percent and reduction_percent");
  }
  if (remaining !== null && reduction !== null && Math.abs(remaining + reduction - 100) > 1)
    return fail(
      "remaining_percent + reduction_percent must equal 100 (remaining = share of normal solar still usable)",
    );
  const pct = remaining ?? 100 - reduction;
  if (pct < 0 || pct > 100) return fail("solar percentages must be within 0-100");
  return ok(r6(pct / 100));
}

function reserveKwh(raw, battery) {
  let kwh = toNumber(raw.minimum_energy_kwh);
  const pct = toNumber(raw.reserve_percent_of_capacity);
  if (kwh === null && pct !== null) {
    if (pct < 0 || pct > 100) return fail("reserve_percent_of_capacity must be within 0-100");
    kwh = (battery.capacity_kwh * pct) / 100;
  }
  if (kwh === null) return fail("minimum_battery_reserve needs minimum_energy_kwh or reserve_percent_of_capacity");
  if (kwh < 0 || kwh > battery.capacity_kwh) return fail("reserve must be between 0 and the battery capacity");
  return ok(r6(kwh));
}

function gridCap(raw) {
  const cap = toNumber(raw.max_grid_kwh);
  if (cap === null || cap < 0) return fail("max_grid_window needs a non-negative max_grid_kwh");
  return ok(r6(cap));
}

function cleanExplanation(text, type) {
  const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 240) : "";
  if (clean) return clean;
  return type === "no_op" ? "This note does not affect the 24-hour energy schedule." : `Interpreted as ${type}.`;
}

const entry = (noteIndex, type, adjustment, explanation) => ({
  note_index: noteIndex,
  applies: type !== "no_op",
  directive_type: type,
  structured_adjustment: adjustment,
  explanation,
});

function normalizeNote(raw, noteIndex, battery) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("each result must be a JSON object");
  const type = typeof raw.directive_type === "string" ? raw.directive_type.trim().toLowerCase() : raw.directive_type;
  if (!DIRECTIVE_TYPES.includes(type)) return fail(`directive_type must be one of: ${DIRECTIVE_TYPES.join(", ")}`);
  const explanation = cleanExplanation(raw.explanation, type);
  if (type === "no_op") return ok(entry(noteIndex, type, null, explanation));

  const hours = resolveHours(raw);
  if (!hours.ok) return hours;
  const adjustment = { hours: hours.value };
  const extras = {
    solar_reduction: () => solarFactor(raw),
    minimum_battery_reserve: () => reserveKwh(raw, battery),
    max_grid_window: () => gridCap(raw),
  };
  const key = {
    solar_reduction: "factor",
    minimum_battery_reserve: "minimum_energy_kwh",
    max_grid_window: "max_grid_kwh",
  };
  if (extras[type]) {
    const value = extras[type]();
    if (!value.ok) return value;
    adjustment[key[type]] = value.value;
  }
  return ok(entry(noteIndex, type, adjustment, explanation));
}

function safeNoOp(noteIndex) {
  return entry(
    noteIndex,
    "no_op",
    null,
    "Note could not be interpreted into a valid directive; no constraint applied.",
  );
}

module.exports = { normalizeNote, expandWindows, parseBatch, parseJson, safeNoOp };
