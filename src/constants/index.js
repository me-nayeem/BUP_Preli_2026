const HOURS = 24;

const DIRECTIVE_TYPES = [
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
];

const BATTERY_ACTIONS = ["charge", "discharge", "idle"];

const BATTERY_FIELDS = [
  "capacity_kwh",
  "initial_energy_kwh",
  "minimum_energy_kwh",
  "max_charge_kwh_per_hour",
  "max_discharge_kwh_per_hour",
];

const REPLAY_TOLERANCE = 1e-3;

const MAX_ABS_VALUE = 1e9;

module.exports = { HOURS, DIRECTIVE_TYPES, BATTERY_ACTIONS, BATTERY_FIELDS, REPLAY_TOLERANCE, MAX_ABS_VALUE };
