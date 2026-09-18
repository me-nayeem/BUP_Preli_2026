#!/usr/bin/env node
// GridWise hard-case checker. No dependencies, Node 18+.
// Usage: node check-hard-cases.js [BASE_URL] [hard-cases.json]
// Checks: health, 400 contract tests, exact interpretation, judge-style replay
// against the GROUND-TRUTH directives, totals, and cost vs the known optimum.

const fs = require("fs");
const path = require("path");

const BASE = (process.argv[2] || process.env.BASE_URL || "http://localhost:8000").replace(/\/$/, "");
const FILE = process.argv[3] || path.join(__dirname, "hard-cases.json");
const DATA = JSON.parse(fs.readFileSync(FILE, "utf8"));
const TOL = DATA.tolerance ?? 0.01;
const TYPES = [
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
];
const REQUIRED_KEYS = {
  solar_reduction: ["factor", "hours"],
  minimum_battery_reserve: ["hours", "minimum_energy_kwh"],
  no_charge_window: ["hours"],
  no_discharge_window: ["hours"],
  max_grid_window: ["hours", "max_grid_kwh"],
};

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};
const warn = (m) => console.log(`  \x1b[33mWARN\x1b[0m ${m}`);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const near = (a, b) => Math.abs(a - b) <= TOL;

async function post(body, raw = false) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/optimize-energy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });
  const ms = Date.now() - t0;
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, ms };
}

async function checkHealth() {
  console.log(`\n== GET /health (${BASE})`);
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => null);
    r.status === 200 && j?.status === "ok"
      ? ok(`200 ${JSON.stringify(j)}`)
      : bad(`status ${r.status}, body ${JSON.stringify(j)}`);
  } catch (e) {
    bad(`health unreachable: ${e.message}`);
  }
}

async function checkContract() {
  console.log("\n== Contract: invalid requests must return 400 JSON (not HTML)");
  const base = DATA.cases[0].request;
  const tests = [
    ["malformed JSON", '{"scenario_id": "X", bad', true],
    ["23 hour entries", { ...base, hours: base.hours.slice(0, 23) }],
    ["4 operator notes", { ...base, operator_notes: ["a", "b", "c", "d"] }],
    ["empty-string note", { ...base, operator_notes: ["   "] }],
    ["demand as string", { ...base, hours: base.hours.map((h, i) => (i ? h : { ...h, demand_kwh: "180" })) }],
  ];
  for (const [name, body, raw] of tests) {
    try {
      const r = await post(body, !!raw);
      if (r.status === 400 && r.json) ok(`${name} -> 400 JSON`);
      else if (r.status === 400) bad(`${name} -> 400 but body is not JSON: ${r.text.slice(0, 80)}`);
      else bad(`${name} -> ${r.status} (expected 400)`);
    } catch (e) {
      bad(`${name} -> request failed: ${e.message}`);
    }
  }
}

function checkInterpretation(got, expected, notes) {
  if (!Array.isArray(got)) return bad("directive_interpretation is not an array");
  if (got.length !== notes.length) return bad(`expected ${notes.length} entries, got ${got.length}`);
  got.forEach((g, i) => {
    const e = expected[i];
    const tag = `note ${i}`;
    const errs = [];
    if (g.note_index !== i) errs.push(`note_index ${g.note_index} (expected ${i})`);
    if (!TYPES.includes(g.directive_type)) errs.push(`unsupported type "${g.directive_type}"`);
    if (g.directive_type !== e.directive_type) errs.push(`type "${g.directive_type}" (expected "${e.directive_type}")`);
    if (g.applies !== e.applies) errs.push(`applies ${g.applies} (expected ${e.applies})`);
    if (typeof g.explanation !== "string") errs.push("explanation missing/not a string");
    if (e.directive_type === "no_op") {
      if (g.structured_adjustment !== null)
        errs.push(`structured_adjustment must be null, got ${JSON.stringify(g.structured_adjustment)}`);
    } else if (g.directive_type === e.directive_type) {
      const a = g.structured_adjustment,
        x = e.structured_adjustment;
      if (!a || typeof a !== "object") errs.push("structured_adjustment missing");
      else {
        const keys = Object.keys(a).sort().join(","),
          need = REQUIRED_KEYS[e.directive_type].join(",");
        if (keys !== need) errs.push(`adjustment keys {${keys}} (expected {${need}})`);
        const hrs = a.hours;
        const sortedUnique =
          Array.isArray(hrs) &&
          hrs.every((h, k) => Number.isInteger(h) && h >= 0 && h <= 23 && (k === 0 || h > hrs[k - 1]));
        if (!sortedUnique) errs.push(`hours not unique ascending ints 0-23: ${JSON.stringify(hrs)}`);
        if (JSON.stringify(hrs) !== JSON.stringify(x.hours))
          errs.push(`hours ${JSON.stringify(hrs)} (expected ${JSON.stringify(x.hours)})`);
        for (const k of ["factor", "minimum_energy_kwh", "max_grid_kwh"])
          if (k in x && !(isNum(a[k]) && near(a[k], x[k]))) errs.push(`${k} ${a[k]} (expected ${x[k]})`);
      }
    }
    errs.length
      ? bad(`${tag}: ${errs.join("; ")}\n         why: ${e.why}`)
      : ok(`${tag}: ${e.directive_type} ${JSON.stringify(e.structured_adjustment)}`);
  });
}

// Judge-style replay using the GROUND-TRUTH directives (not your reported ones).
function replay(req, truth, body) {
  const errs = [];
  const byHour = new Array(24);
  for (const e of req.hours) byHour[e.hour] = e;
  const b = req.battery,
    plan = body.hourly_plan;
  if (!Array.isArray(plan) || plan.length !== 24)
    return { errs: [`hourly_plan must have 24 entries (got ${plan?.length})`], cost: NaN };
  const factor = Array(24).fill(1),
    minE = Array(24).fill(b.minimum_energy_kwh);
  const noChg = Array(24).fill(false),
    noDis = Array(24).fill(false),
    cap = Array(24).fill(Infinity);
  for (const t of truth) {
    if (!t.applies) continue;
    const a = t.structured_adjustment;
    for (const h of a.hours) {
      if (t.directive_type === "solar_reduction") factor[h] *= a.factor;
      if (t.directive_type === "minimum_battery_reserve") minE[h] = Math.max(minE[h], a.minimum_energy_kwh);
      if (t.directive_type === "no_charge_window") noChg[h] = true;
      if (t.directive_type === "no_discharge_window") noDis[h] = true;
      if (t.directive_type === "max_grid_window") cap[h] = Math.min(cap[h], a.max_grid_kwh);
    }
  }
  let soc = b.initial_energy_kwh;
  const seen = new Set();
  plan.forEach((p, i) => {
    const h = p.hour;
    if (!Number.isInteger(h) || h < 0 || h > 23 || seen.has(h)) {
      errs.push(`entry ${i}: bad/duplicate hour ${h}`);
      return;
    }
    seen.add(h);
    if (h !== i) errs.push(`entry ${i}: hour ${h} out of order`);
    const d = byHour[h];
    for (const k of ["grid_kwh", "solar_used_kwh", "battery_kwh", "battery_energy_after_kwh"])
      if (!isNum(p[k]) || p[k] < 0) errs.push(`h${h}: ${k}=${p[k]} not finite/non-negative`);
    if (!["charge", "discharge", "idle"].includes(p.battery_action))
      errs.push(`h${h}: battery_action "${p.battery_action}"`);
    const chg = p.battery_action === "charge" ? p.battery_kwh : 0;
    const dis = p.battery_action === "discharge" ? p.battery_kwh : 0;
    if (p.battery_action === "idle" && Math.abs(p.battery_kwh) > TOL)
      errs.push(`h${h}: idle but battery_kwh=${p.battery_kwh}`);
    if (chg > b.max_charge_kwh_per_hour + TOL) errs.push(`h${h}: charge ${chg} > rate limit`);
    if (dis > b.max_discharge_kwh_per_hour + TOL) errs.push(`h${h}: discharge ${dis} > rate limit`);
    const lhs = p.grid_kwh + p.solar_used_kwh + dis,
      rhs = d.demand_kwh + chg;
    if (!near(lhs, rhs)) errs.push(`h${h}: energy balance ${lhs.toFixed(3)} != ${rhs.toFixed(3)}`);
    const eff = d.solar_kwh * factor[h];
    if (p.solar_used_kwh > eff + TOL) errs.push(`h${h}: solar_used ${p.solar_used_kwh} > effective solar ${eff}`);
    soc += chg - dis;
    if (!near(soc, p.battery_energy_after_kwh))
      errs.push(`h${h}: battery transition (replayed ${soc.toFixed(3)}, reported ${p.battery_energy_after_kwh})`);
    soc = p.battery_energy_after_kwh; // continue from reported value so one error doesn't cascade
    if (soc > b.capacity_kwh + TOL) errs.push(`h${h}: battery ${soc} > capacity`);
    if (soc < minE[h] - TOL)
      errs.push(
        `h${h}: battery ${soc} < required minimum ${minE[h]}${minE[h] > b.minimum_energy_kwh ? " (reserve directive)" : ""}`,
      );
    if (noChg[h] && p.battery_action === "charge" && chg > TOL) errs.push(`h${h}: charging inside no_charge_window`);
    if (noDis[h] && p.battery_action === "discharge" && dis > TOL)
      errs.push(`h${h}: discharging inside no_discharge_window`);
    if (p.grid_kwh > cap[h] + TOL) errs.push(`h${h}: grid ${p.grid_kwh} > cap ${cap[h]}`);
  });
  if (plan.length === 24 && !near(plan[23]?.battery_energy_after_kwh, b.initial_energy_kwh))
    errs.push(`end-of-day battery ${plan[23]?.battery_energy_after_kwh} != initial ${b.initial_energy_kwh}`);
  const tg = plan.reduce((s, p) => s + (p.grid_kwh || 0), 0);
  const tc = plan.reduce((s, p) => s + (p.grid_kwh || 0) * (byHour[p.hour]?.tariff_bdt_per_kwh || 0), 0);
  const pk = Math.max(...plan.map((p) => p.grid_kwh || 0));
  if (!near(tg, body.total_grid_kwh)) errs.push(`total_grid_kwh ${body.total_grid_kwh} != recomputed ${tg.toFixed(4)}`);
  if (!near(tc, body.total_cost_bdt)) errs.push(`total_cost_bdt ${body.total_cost_bdt} != recomputed ${tc.toFixed(4)}`);
  if (!near(pk, body.peak_grid_kwh)) errs.push(`peak_grid_kwh ${body.peak_grid_kwh} != recomputed ${pk.toFixed(4)}`);
  return { errs, cost: tc };
}

function diagnoseCost(cost, exp) {
  for (const d of exp.wrong_answer_costs || []) if (d.cost_bdt !== null && near(cost, d.cost_bdt)) return d.likely_bug;
  return null;
}

async function runCase(c) {
  const req = c.request,
    exp = c.expected;
  console.log(`\n== ${c.name}`);
  let r;
  try {
    r = await post(req);
  } catch (e) {
    return bad(`request failed: ${e.message}`);
  }
  console.log(`  latency ${r.ms} ms${r.ms > 5000 ? "  (above the 5 s p95 target)" : ""}`);
  if (r.status !== 200 || !r.json) {
    const infeasibleHint = (exp.wrong_answer_costs || []).filter((d) => d.cost_bdt === null).map((d) => d.likely_bug);
    bad(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.status === 422 && infeasibleHint.length)
      console.log(`         hint: infeasible usually means -> ${infeasibleHint.join(" OR ")}`);
    if (r.status === 400 && exp.robustness_note) console.log(`         hint: ${exp.robustness_note}`);
    return;
  }
  const body = r.json;
  const topErrs = [];
  if (body.scenario_id !== req.scenario_id) topErrs.push(`scenario_id "${body.scenario_id}" not echoed`);
  for (const k of ["total_grid_kwh", "total_cost_bdt", "peak_grid_kwh"])
    if (!isNum(body[k])) topErrs.push(`${k} missing/not a number`);
  if (typeof body.plan_summary !== "string") topErrs.push("plan_summary missing");
  topErrs.length ? bad(`top-level: ${topErrs.join("; ")}`) : ok("top-level fields + scenario_id echo");

  console.log("  -- interpretation");
  checkInterpretation(body.directive_interpretation, exp.directive_interpretation, req.operator_notes);

  console.log("  -- schedule replay against ground-truth directives");
  const { errs, cost } = replay(req, exp.directive_interpretation, body);
  if (errs.length) {
    bad(`${errs.length} violation(s):`);
    errs.slice(0, 12).forEach((e) => console.log(`         - ${e}`));
  } else ok("energy balance, battery, rate limits, directives, neutrality, totals");

  console.log("  -- cost");
  const opt = exp.optimal_total_cost_bdt;
  const hint = diagnoseCost(cost, exp);
  if (near(cost, opt)) ok(`cost ${cost.toFixed(2)} = optimal ${opt}`);
  else if (cost < opt)
    bad(
      `cost ${cost.toFixed(2)} is BELOW the true optimum ${opt} -> a ground-truth constraint is being ignored${hint ? `\n         likely bug: ${hint}` : ""}`,
    );
  else {
    const ratio = Math.min(1, opt / cost);
    (errs.length ? bad : warn)(
      `cost ${cost.toFixed(2)} vs optimal ${opt} (quality ratio ${ratio.toFixed(4)})${hint ? `\n         likely bug: ${hint}` : ""}`,
    );
  }
}

(async () => {
  await checkHealth();
  await checkContract();
  for (const c of DATA.cases) await runCase(c);
  console.log(
    `\n${failures === 0 ? "\x1b[32mALL CHECKS PASSED\x1b[0m" : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}`,
  );
  process.exit(failures ? 1 : 0);
})();
