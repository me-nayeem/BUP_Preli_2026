try {
  process.loadEnvFile();
} catch {}

const config = require("./config");
const app = require("./app");
const { warmUp } = require("./services/optimizer.service");

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message));

warmUp().then(() => {
  const server = app.listen(config.port, config.host, 1024, () => {
    const models = config.llm.providers.map((p) => `${p.label}=${p.model}`).join(", ") || "none configured";
    console.log(`GridWise listening on ${config.host}:${config.port} (LLM: ${models})`);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
});
