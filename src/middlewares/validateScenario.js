const { validateScenario } = require("../validators/scenario.validator");

function validateScenarioBody(req, res, next) {
  const result = validateScenario(req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  req.scenario = result.scenario;
  next();
}

module.exports = { validateScenarioBody };
