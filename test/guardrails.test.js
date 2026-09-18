const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeNote, parseBatch, expandWindows } = require("../src/services/guardrails.service");

const BATTERY = { capacity_kwh: 500 };
const norm = (raw) => normalizeNote(raw, 0, BATTERY);
const accepted = (raw) => {
  const r = norm(raw);
  assert.ok(r.ok, r.error);
  return r.value;
};
const rejected = (raw, pattern) => {
  const r = norm(raw);
  assert.equal(r.ok, false);
  if (pattern) assert.match(r.error, pattern);
};
const solar = (extra) => ({ directive_type: "solar_reduction", windows: [{ start_hour: 13, end_hour: 15 }], ...extra });

test("unparseable text is rejected at batch level", () => {
  assert.equal(parseBatch("Sure! Here's the JSON you asked for.", 1).ok, false);
});

test("batch parsing: fences, bare object, wrong count, reordering by index", () => {
  const one = '```json\n{"results":[{"index":0,"directive_type":"no_op"}]}\n```';
  assert.equal(parseBatch(one, 1).value.length, 1);
  assert.equal(parseBatch('{"directive_type":"no_op"}', 1).value[0].directive_type, "no_op");
  assert.match(parseBatch('{"results":[{"index":0}]}', 2).error, /exactly 2/);
  const swapped = parseBatch('{"results":[{"index":1,"x":"b"},{"index":0,"x":"a"}]}', 2).value;
  assert.deepEqual(
    swapped.map((i) => i.x),
    ["a", "b"],
  );
  assert.equal(parseBatch('{"results":[{"index":0},{"index":0}]}', 2).ok, false);
  assert.equal(parseBatch('[{"directive_type":"no_op"}]', 1).ok, true);
});

test("unsupported directive_type is rejected", () => {
  rejected({ directive_type: "battery_limit", windows: [{ start_hour: 1, end_hour: 2 }] }, /directive_type/);
  rejected({ windows: [] }, /directive_type/);
  rejected(null);
  rejected([]);
});

test("directive_type is case/whitespace tolerant", () => {
  assert.equal(accepted({ directive_type: " No_Op " }).directive_type, "no_op");
});

test("invalid windows are rejected", () => {
  for (const w of [
    { start_hour: 13, end_hour: 13 },
    { start_hour: -1, end_hour: 3 },
    { start_hour: 20, end_hour: 25 },
    { start_hour: 1.5, end_hour: 3 },
  ])
    rejected({ directive_type: "no_charge_window", windows: [w] });
  rejected({ directive_type: "no_charge_window", windows: [{ start_hour: 22, end_hour: 2 }] }, /split windows/);
  rejected({ directive_type: "no_charge_window", windows: [] }, /non-empty/);
  rejected({ directive_type: "no_charge_window" }, /non-empty/);
});

test("windows are expanded end-exclusive, merged, unique and sorted", () => {
  assert.deepEqual(
    expandWindows([
      { start_hour: 14, end_hour: 16 },
      { start_hour: 13, end_hour: 15 },
    ]).value,
    [13, 14, 15],
  );
  assert.deepEqual(expandWindows([{ start_hour: 22, end_hour: 0 }]).value, [22, 23]);
  assert.deepEqual(
    expandWindows([
      { start_hour: 22, end_hour: 24 },
      { start_hour: 0, end_hour: 2 },
    ]).value,
    [0, 1, 22, 23],
  );
  assert.deepEqual(expandWindows([{ start_hour: 0, end_hour: 24 }]).value.length, 24);
});

test("numeric strings are coerced", () => {
  const v = accepted({ directive_type: "no_discharge_window", windows: [{ start_hour: "13", end_hour: "15" }] });
  assert.deepEqual(v.structured_adjustment, { hours: [13, 14] });
});

test("explicit hours list is accepted when windows are missing", () => {
  const v = accepted({ directive_type: "no_charge_window", hours: [15, 14, 14] });
  assert.deepEqual(v.structured_adjustment.hours, [14, 15]);
  rejected({ directive_type: "no_charge_window", hours: [24] });
});

test("solar factor semantics", () => {
  assert.equal(accepted(solar({ remaining_percent: 20, reduction_percent: 80 })).structured_adjustment.factor, 0.2);
  assert.equal(accepted(solar({ remaining_percent: 20 })).structured_adjustment.factor, 0.2);
  assert.equal(accepted(solar({ reduction_percent: 30 })).structured_adjustment.factor, 0.7);
  assert.equal(accepted(solar({ remaining_percent: 0, reduction_percent: 100 })).structured_adjustment.factor, 0);
  assert.equal(accepted(solar({ remaining_percent: "25%" })).structured_adjustment.factor, 0.25);
  assert.equal(accepted(solar({ factor: 0.4 })).structured_adjustment.factor, 0.4);
  rejected(solar({ remaining_percent: 20, reduction_percent: 20 }), /equal 100/);
  rejected(solar({ reduction_percent: 120 }), /0-100/);
  rejected(solar({}), /remaining_percent/);
  rejected(solar({ factor: 1.5 }));
});

test("reserve semantics", () => {
  const reserve = (extra) => ({
    directive_type: "minimum_battery_reserve",
    windows: [{ start_hour: 18, end_hour: 21 }],
    ...extra,
  });
  assert.deepEqual(accepted(reserve({ minimum_energy_kwh: 120 })).structured_adjustment, {
    hours: [18, 19, 20],
    minimum_energy_kwh: 120,
  });
  assert.equal(accepted(reserve({ reserve_percent_of_capacity: 40 })).structured_adjustment.minimum_energy_kwh, 200);
  assert.equal(accepted(reserve({ minimum_energy_kwh: 500 })).structured_adjustment.minimum_energy_kwh, 500);
  rejected(reserve({ minimum_energy_kwh: 600 }), /capacity/);
  rejected(reserve({ minimum_energy_kwh: -1 }), /capacity/);
  rejected(reserve({ reserve_percent_of_capacity: 140 }));
  rejected(reserve({}), /needs/);
});

test("grid cap semantics", () => {
  const grid = (extra) => ({
    directive_type: "max_grid_window",
    windows: [{ start_hour: 17, end_hour: 20 }],
    ...extra,
  });
  assert.equal(accepted(grid({ max_grid_kwh: 0 })).structured_adjustment.max_grid_kwh, 0);
  assert.equal(accepted(grid({ max_grid_kwh: "150" })).structured_adjustment.max_grid_kwh, 150);
  rejected(grid({ max_grid_kwh: -5 }), /non-negative/);
  rejected(grid({}), /non-negative/);
});

test("no_op carrying windows and numbers still yields applies:false and null adjustment", () => {
  const v = accepted({
    directive_type: "no_op",
    windows: [{ start_hour: 1, end_hour: 5 }],
    max_grid_kwh: 5,
    explanation: "Unrelated.",
  });
  assert.deepEqual(v, {
    note_index: 0,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation: "Unrelated.",
  });
});

test("invented fields never reach the output", () => {
  const v = accepted({
    directive_type: "max_grid_window",
    windows: [{ start_hour: 1, end_hour: 2 }],
    max_grid_kwh: 50,
    demand_kwh: 999,
    tariff_bdt_per_kwh: 0,
    applies: false,
    note_index: 7,
    factor: 0.5,
  });
  assert.deepEqual(Object.keys(v), ["note_index", "applies", "directive_type", "structured_adjustment", "explanation"]);
  assert.deepEqual(v.structured_adjustment, { hours: [1], max_grid_kwh: 50 });
  assert.equal(v.applies, true);
  assert.equal(v.note_index, 0);
});

test("only the fields required by each directive type appear", () => {
  const v = accepted({
    directive_type: "no_charge_window",
    windows: [{ start_hour: 2, end_hour: 5 }],
    max_grid_kwh: 10,
    remaining_percent: 10,
  });
  assert.deepEqual(v.structured_adjustment, { hours: [2, 3, 4] });
});

test("missing or oversized explanation gets a safe default / trimmed", () => {
  assert.equal(accepted({ directive_type: "no_op" }).explanation.length > 0, true);
  const long = accepted({ directive_type: "no_op", explanation: "x".repeat(1000) }).explanation;
  assert.ok(long.length <= 240);
});
