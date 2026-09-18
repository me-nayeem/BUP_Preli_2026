const { Router } = require("express");

const router = Router();

router.use(require("./health.routes"));
router.use(require("./energy.routes"));

module.exports = router;
