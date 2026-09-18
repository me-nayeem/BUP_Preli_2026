const { Router } = require("express");
const { validateScenarioBody } = require("../middlewares/validateScenario");
const { optimizeEnergy } = require("../controllers/energy.controller");

const router = Router();

router.post("/optimize-energy", validateScenarioBody, optimizeEnergy);

module.exports = router;
