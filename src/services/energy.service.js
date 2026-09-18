const { interpretAll } = require("./interpreter.service");
const { buildLimits } = require("./limits.service");
const { optimize } = require("./optimizer.service");
const { buildResponse } = require("./response.service");
const { replay } = require("./replay.service");
const { HttpError } = require("../utils/httpError");

async function planFromInterpretations(sc, interps) {
  const limits = buildLimits(sc, interps);
  const result = await optimize(sc, limits);
  if (!result.ok) throw new HttpError(422, "infeasible_after_directives");
  const body = buildResponse(sc, interps, result.plan);
  const errors = replay(sc, interps, body);
  if (errors.length) {
    console.error(`[${sc.scenario_id}] replay failed:`, errors.slice(0, 5));
    throw new HttpError(500, "schedule_verification_failed");
  }
  return body;
}

async function optimizeEnergy(sc) {
  const interps = await interpretAll(sc.operator_notes, sc.battery);
  return planFromInterpretations(sc, interps);
}

module.exports = { optimizeEnergy, planFromInterpretations };
