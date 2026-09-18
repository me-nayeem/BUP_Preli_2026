const test = require("node:test");
const assert = require("node:assert/strict");
const { cases } = require("./fixtures/public_sample_cases.json");
const { validateScenario } = require("../src/validators/scenario.validator");
const { planFromInterpretations } = require("../src/services/energy.service");

for (const c of cases) {
  test(`${c.id} optimal cost with reference interpretation`, async () => {
    const { ok, scenario } = validateScenario(c.input);
    assert.ok(ok);
    const body = await planFromInterpretations(scenario, c.expected_output.directive_interpretation);
    const expected = c.expected_output.total_cost_bdt;
    assert.ok(
      Math.abs(body.total_cost_bdt - expected) <= 0.01,
      `expected cost ${expected}, got ${body.total_cost_bdt}`,
    );
  });
}
