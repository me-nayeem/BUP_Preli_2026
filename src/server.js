try {
  process.loadEnvFile();
} catch {}

const express = require("express");
const { validateRequest } = require("./validateRequest");

const r6 = (x) => Math.round(x * 1e6) / 1e6;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

app.post("/optimize-energy", async (req, res) => {
  const v = validateRequest(req.body);
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  const sc = v.scenario;
  try {
    const interps = sc.operator_notes.map((_, i) => ({
      note_index: i,
      applies: false,
      directive_type: "no_op",
      structured_adjustment: null,
      explanation: "Stub: interpretation not implemented yet.",
    }));
    const plan = sc.hours.map((d, h) => {
      const solar = r6(Math.min(d.solar_kwh, d.demand_kwh));
      return {
        hour: h,
        grid_kwh: r6(d.demand_kwh - solar),
        solar_used_kwh: solar,
        battery_action: "idle",
        battery_kwh: 0,
        battery_energy_after_kwh: sc.battery.initial_energy_kwh,
      };
    });
    res.status(200).json(assemble(sc, interps, plan));
  } catch (e) {
    console.error(`[${sc.scenario_id}] error: ${e.message}`);
    res.status(500).json({ error: "internal_error" });
  }
});

function assemble(sc, interps, plan) {
  const total_grid_kwh = r6(plan.reduce((a, p) => a + p.grid_kwh, 0));
  const total_cost_bdt = r6(plan.reduce((a, p, h) => a + p.grid_kwh * sc.hours[h].tariff_bdt_per_kwh, 0));
  const peak_grid_kwh = Math.max(...plan.map((p) => p.grid_kwh));
  const applied = interps.filter((i) => i.applies).map((i) => i.directive_type);
  const ch = plan.filter((p) => p.battery_action === "charge").map((p) => p.hour);
  const dis = plan.filter((p) => p.battery_action === "discharge").map((p) => p.hour);
  const plan_summary =
    `Applied ${applied.length} directive(s)${applied.length ? ` (${applied.join(", ")})` : ""}; ` +
    `${interps.length - applied.length} note(s) treated as no_op. Battery charges in hours [${ch}] ` +
    `and discharges in hours [${dis}], ending at its starting level. ` +
    `Total grid cost ${total_cost_bdt.toFixed(2)} BDT, peak grid ${peak_grid_kwh.toFixed(2)} kWh.`;
  return {
    scenario_id: sc.scenario_id,
    directive_interpretation: interps,
    hourly_plan: plan,
    total_grid_kwh,
    total_cost_bdt,
    peak_grid_kwh,
    plan_summary,
  };
}

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "malformed_json" });
  if (err.type === "entity.too.large") return res.status(400).json({ error: "payload_too_large" });
  console.error("unhandled:", err.message);
  res.status(500).json({ error: "internal_error" });
});
app.use((req, res) => res.status(404).json({ error: "not_found" }));

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message));

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 8000;
  app.listen(PORT, "0.0.0.0", () => console.log(`GridWise listening on 0.0.0.0:${PORT}`));
}

module.exports = { app, assemble };
