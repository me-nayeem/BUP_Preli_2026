const { cases } = require("../fixtures/public_sample_cases.json");
const { validateScenario } = require("../../src/validators/scenario.validator");
const { replay } = require("../../src/services/replay.service");

const BASE_URL = (process.argv[2] ?? process.env.BASE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 4000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) <= 0.01;

function compareInterpretation(got, expected) {
  const problems = [];
  if (got.length !== expected.length) return [`expected ${expected.length} entries, got ${got.length}`];
  expected.forEach((e, i) => {
    const g = got[i];
    if (g.note_index !== i) problems.push(`note ${i}: note_index ${g.note_index}`);
    if (g.directive_type !== e.directive_type || g.applies !== e.applies)
      problems.push(`note ${i}: expected ${e.directive_type}, got ${g.directive_type} (applies ${g.applies})`);
    else if (e.structured_adjustment) {
      for (const [k, v] of Object.entries(e.structured_adjustment)) {
        const gv = g.structured_adjustment?.[k];
        const same = Array.isArray(v) ? JSON.stringify(v) === JSON.stringify(gv) : near(v, gv);
        if (!same) problems.push(`note ${i}: ${k} expected ${JSON.stringify(v)}, got ${JSON.stringify(gv)}`);
      }
    } else if (g.structured_adjustment !== null) problems.push(`note ${i}: no_op must have null adjustment`);
  });
  return problems;
}

(async () => {
  const health = await fetch(`${BASE_URL}/health`)
    .then((r) => r.json())
    .catch(() => null);
  if (health?.status !== "ok") {
    console.error(`${BASE_URL}/health is not ok`);
    process.exit(1);
  }
  let passed = 0;
  const latencies = [];
  for (const [k, c] of cases.entries()) {
    const t = Date.now();
    const res = await fetch(`${BASE_URL}/optimize-energy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.input),
    });
    latencies.push(Date.now() - t);
    const body = await res.json();
    const problems = res.status === 200 ? [] : [`HTTP ${res.status} ${JSON.stringify(body)}`];
    if (res.status === 200) {
      const sc = validateScenario(c.input).scenario;
      problems.push(
        ...compareInterpretation(body.directive_interpretation, c.expected_output.directive_interpretation),
      );
      problems.push(
        ...replay(sc, c.expected_output.directive_interpretation, body).map((e) => `ground-truth replay: ${e}`),
      );
      if (body.total_cost_bdt > c.expected_output.total_cost_bdt + 0.01)
        problems.push(`cost ${body.total_cost_bdt} > optimal ${c.expected_output.total_cost_bdt}`);
    }
    if (problems.length) console.log(`FAIL ${c.id} (${latencies.at(-1)} ms)\n  ${problems.join("\n  ")}`);
    else {
      passed++;
      console.log(`PASS ${c.id} (${latencies.at(-1)} ms) cost ${body.total_cost_bdt}`);
    }
    if (k < cases.length - 1) await sleep(DELAY_MS);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(
    `\n${passed}/${cases.length} public samples passed | p95 ${sorted[Math.ceil(sorted.length * 0.95) - 1]} ms`,
  );
  process.exit(passed === cases.length ? 0 : 1);
})();
