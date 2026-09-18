const energyService = require("../services/energy.service");

async function optimizeEnergy(req, res, next) {
  try {
    const body = await energyService.optimizeEnergy(req.scenario);
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

module.exports = { optimizeEnergy };
