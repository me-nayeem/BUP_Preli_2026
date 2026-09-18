const { Router } = require("express");
const { getHealth } = require("../controllers/health.controller");

const router = Router();

router.get("/health", getHealth);

module.exports = router;
