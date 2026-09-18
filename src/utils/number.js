const r6 = (x) => Math.round(x * 1e6) / 1e6;

const isFiniteNumber = (x) => typeof x === "number" && Number.isFinite(x);

module.exports = { r6, isFiniteNumber };
