const { HttpError } = require("../utils/httpError");

function notFound(req, res) {
  res.status(404).json({ error: "not_found" });
}

function errorHandler(err, req, res, next) {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "malformed_json" });
  if (err.type === "entity.too.large") return res.status(400).json({ error: "payload_too_large" });
  if (err.type) return res.status(400).json({ error: "invalid_body" });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error("unhandled:", err.message);
  res.status(500).json({ error: "internal_error" });
}

module.exports = { notFound, errorHandler };
