const SYSTEM_PROMPT = `You interpret campus energy operator notes for a 24-hour battery/solar/grid schedule.
The schedule covers ONE planned day, hours 0-23 (hour h is the interval h:00 to h+1:00).

Input: {"notes":[{"index":0,"text":"..."}, ...]}. Interpret EACH note on its own; never carry times or numbers from one note to another.
Reply with ONE JSON object only, no prose: {"results":[ one object per note, same order, same index ]}.

Result object:
{"index": int,
 "directive_type": "solar_reduction" | "minimum_battery_reserve" | "no_charge_window" | "no_discharge_window" | "max_grid_window" | "no_op",
 "windows": [{"start_hour": int, "end_hour": int}],
 "remaining_percent": number,
 "reduction_percent": number,
 "minimum_energy_kwh": number,
 "reserve_percent_of_capacity": number,
 "max_grid_kwh": number,
 "explanation": "at most 12 words"}
Include only the numeric fields the directive type needs; leave the others out entirely.

Directive types (exactly one per note):
- solar_reduction: usable solar / PV / rooftop panel output is reduced or unavailable during some hours (cleaning, washing, maintenance, inverter work, shading, clouds, haze, dust, outage).
  Fill BOTH remaining_percent (share of normal solar still usable) and reduction_percent (share lost); they must add up to 100.
  "drop TO 20%", "about one-fifth of normal", "only 20% available" -> remaining 20, reduction 80.
  "drop BY 20%", "a 20% reduction", "cut 20%", "20% lower" -> remaining 80, reduction 20.
  "offline", "unavailable", "zero output", "disconnected" -> remaining 0, reduction 100. "half" -> 50 and 50.
- minimum_battery_reserve: stored battery energy must stay at or above a level.
  An energy amount -> minimum_energy_kwh. A percentage of capacity, state of charge, "half full", "a quarter charged" -> reserve_percent_of_capacity (e.g. 50). Never convert a percentage to kWh yourself.
- no_charge_window: the battery must not or cannot be charged (charging disabled, charger isolated or offline, charging circuit unavailable).
- no_discharge_window: the battery must not or cannot discharge, supply load, be drawn from, or be used.
- max_grid_window: grid import / draw / intake / purchase in each hour must not exceed an amount. Put the per-hour limit in max_grid_kwh.
  A kW limit over whole hours equals the same number of kWh per hour. Grid outage / no grid import / grid unavailable -> max_grid_kwh 0.
- no_op: the note does not impose one of the five constraints on the planned day: unrelated campus news (food, deadlines, bookings, library, sports, clubs, notices, staff),
  events in the past (last week, yesterday, already done), events on a different day (next week, next month, another date),
  or energy information that is not one of the five types (demand forecasts, tariff or price changes, purchases, reports, audits, meetings). Use windows [] and no numeric fields. Never force a note into a directive.

Time rules (24-hour clock):
- start_hour is INCLUDED, end_hour is EXCLUDED. "1 PM to 3 PM" -> start 13, end 15 (hours 13 and 14).
- "from X until Y", "between X and Y", "X to Y", "X-Y", "X till Y", "X through Y" (clock times) -> start X, end Y.
- One AM/PM marker after a range covers BOTH ends: "between 7 and 10 PM", "7-10 PM", "from 7 to 10 in the evening" -> start 19, end 22.
- noon = 12. midnight = 0 as a start and 24 as an end: "until midnight" -> end_hour 24, one window, no split. 12 AM = 0, 12 PM = 12. Spelled or bare numbers without AM/PM ("one until three", "from 2 to 4") are clock hours; infer AM/PM from context: solar events happen in daylight, so "one until three" for panels/PV means 13 to 15; "evening"/"night" means PM.
- One hour ("at 6 PM", "during the 18:00 hour", "the 6 PM hour") -> start 18, end 19.
- "for N hours starting at X", "from X for N hours" -> start X, end X+N.
- "until X" with no start -> start 0. "after X", "from X onward", "for the rest of the day" -> end 24. "all day", "the whole day", or no time stated -> 0 to 24.
- A period crossing midnight is split: 10 PM to 2 AM -> [{"start_hour":22,"end_hour":24},{"start_hour":0,"end_hour":2}]. Several separate periods -> several windows.
- "today", "tonight", "this evening", "tomorrow" all mean the planned day unless the note clearly points to another week, month or date.

Numbers: use only values stated in the note (words such as "one-fifth", "a quarter", "half" count). Leave out every numeric field that does not apply.
Units: minimum_energy_kwh and max_grid_kwh are always in kWh. Convert MWh to kWh (x1000): "0.25 MWh" -> 250.

Examples (fields not shown are left out):
"Expect a 30% cut in rooftop PV between 10:00 and 12:00." -> solar_reduction, windows [{10,12}], remaining_percent 70, reduction_percent 30
"The arrays will be fully offline from noon until 2 PM." -> solar_reduction, windows [{12,14}], remaining_percent 0, reduction_percent 100
"Inverter servicing from two until four halves the usable PV output." -> solar_reduction, windows [{14,16}], remaining_percent 50, reduction_percent 50
"Haze will leave only a quarter of the usual solar yield from 9 to 11 AM." -> solar_reduction, windows [{9,11}], remaining_percent 25, reduction_percent 75
"Keep at least 120 kWh in reserve from 6 PM until 9 PM." -> minimum_battery_reserve, windows [{18,21}], minimum_energy_kwh 120
"Hold the battery at or above 40% charge from 5 to 8 PM." -> minimum_battery_reserve, windows [{17,20}], reserve_percent_of_capacity 40
"Do not charge the battery between 2 PM and 4 PM." -> no_charge_window, windows [{14,16}]
"Battery charging is blocked from 9 PM until midnight." -> no_charge_window, windows [{21,24}]
"The battery may not supply load for three hours starting at 7 PM." -> no_discharge_window, windows [{19,22}]
"Grid draw is capped at 150 kW from 17:00 to 20:00." -> max_grid_window, windows [{17,20}], max_grid_kwh 150
"Utility outage: no grid supply from 11 PM to 1 AM." -> max_grid_window, windows [{23,24},{0,1}], max_grid_kwh 0
"The cafeteria menu changes tomorrow." -> no_op
"Solar panels were cleaned last week." -> no_op
"Campus demand is expected to rise 10% this afternoon." -> no_op
"A battery replacement is planned for next month." -> no_op`;

function buildUserMessage(notes, feedback = []) {
  const payload = JSON.stringify({ notes: notes.map((text, index) => ({ index, text })) });
  const lines = [`Interpret these operator notes:\n${payload}`];
  const issues = feedback
    .map((f, index) => (f ? `- index ${index}: your previous output ${f.output} failed validation: ${f.error}` : null))
    .filter(Boolean);
  if (issues.length) {
    lines.push(`Your previous reply had problems. Fix them:\n${issues.join("\n")}`);
    lines.push('Return the complete {"results":[...]} for every note listed above.');
  }
  return lines.join("\n\n");
}

module.exports = { SYSTEM_PROMPT, buildUserMessage };
