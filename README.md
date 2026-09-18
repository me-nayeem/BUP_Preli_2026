# GridWise LLM: Smart Campus Energy Optimizer

BUP CSE Fest 2026 Hackathon, Online Preliminary.

An HTTP API that reads 1–3 natural-language operator notes with a large language model, validates the interpretation with deterministic guardrails, applies the resulting directives to an exact linear-programming model of the campus battery, solar and grid, and returns the minimum-cost valid 24-hour schedule.

| Submission item | Value                                                             |
| --------------- | ----------------------------------------------------------------- |
| Live base URL   | `<LIVE_BASE_URL>`                                                 |
| Docker image    | `<DOCKER_IMAGE>` (for example `docker.io/<user>/gridwise:v1`)     |
| Service port    | `8000` (override with `PORT`)                                     |
| Endpoints       | `GET /health`, `POST /optimize-energy`                            |
| LLM providers   | OpenAI and Google Gemini (both via Chat Completions API)          |
| LLM models      | `gpt-4o-mini` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` |
| Optimizer       | HiGHS LP solver (`highs` npm package, WebAssembly)                |

---

## 1. Quickstart (local, from a clean machine)

**Prerequisites:** Node.js 22 or newer, npm, and an OpenAI API key. A Google Gemini API key (free at <https://aistudio.google.com/apikey>) is optional and enables the fallback models.

```bash
git clone https://github.com/me-nayeem/BUP_Preli_2026.git
cd BUP_Preli_2026
npm ci
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

Open `.env` and set `LLM_API_KEY` (OpenAI). Optionally set `LLM_FALLBACK_API_KEY` (Gemini) to enable the two Gemini fallback models. All other values in `.env.example` already have working defaults.

```bash
npm start
```

The server prints `GridWise listening on 0.0.0.0:8000 (LLM: primary=..., fallback=...)` and becomes healthy in under one second.

### Check that it works

```bash
curl http://localhost:8000/health
```

Expected: `{"status":"ok"}`

```bash
curl -X POST http://localhost:8000/optimize-energy \
  -H "Content-Type: application/json" \
  -d @examples/sample-request.json
```

On Windows PowerShell, use `curl.exe` instead of `curl`.

[examples/sample-request.json](examples/sample-request.json) is public sample SAMPLE-06: three notes, namely a 50% solar reduction, a no-charge window and a distractor. The expected result, also saved in [examples/sample-response.json](examples/sample-response.json):

| Field                              | Expected value                                                       |
| ---------------------------------- | -------------------------------------------------------------------- |
| `directive_interpretation[0]`      | `solar_reduction`, `{"hours":[10,11],"factor":0.5}`, `applies: true` |
| `directive_interpretation[1]`      | `no_charge_window`, `{"hours":[14,15]}`, `applies: true`             |
| `directive_interpretation[2]`      | `no_op`, `structured_adjustment: null`, `applies: false`             |
| `total_cost_bdt`                   | `34090` (equal to the organizer's optimal reference cost)            |
| `total_grid_kwh` / `peak_grid_kwh` | `2395` / `175`                                                       |
| `hourly_plan`                      | 24 entries, hours 0–23, battery ends at its initial 100 kWh          |

The explanation text may be worded differently on each run; the structured fields are deterministic.

---

## 2. Run with Docker (fallback execution path)

```bash
docker pull <DOCKER_IMAGE>
docker run --rm -p 8000:8000 \
  -e LLM_API_KEY=<your-openai-key> \
  -e LLM_MODEL=gpt-4o-mini \
  -e LLM_FALLBACK_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
  -e LLM_FALLBACK_API_KEY=<your-gemini-key> \
  -e LLM_FALLBACK_MODEL=gemini-3.5-flash-lite \
  -e LLM_FALLBACK2_MODEL=gemini-3.1-flash-lite \
  <DOCKER_IMAGE>
curl http://localhost:8000/health
```

Or pass a whole file with `--env-file .env`. To build the image yourself: `docker build -t gridwise:local .`

The image uses `node:22-slim`, runs as the non-root `node` user, binds to `0.0.0.0:8000`, has a Docker `HEALTHCHECK` on `/health`, and contains **no secrets**. `.env` is excluded by `.dockerignore`, so every credential is supplied at run time.

---

## 3. Configuration

Only variable names are listed here; never commit real values.

| Variable                        | Required | Default                                         | Meaning                                                                   |
| ------------------------------- | -------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `LLM_API_KEY`                   | yes      | none                                            | API key for the primary model (OpenAI)                                    |
| `LLM_MODEL`                     | yes      | none                                            | Primary model, e.g. `gpt-4o-mini`                                         |
| `LLM_BASE_URL`                  | no       | `https://api.openai.com/v1`                     | Any OpenAI-compatible `/chat/completions` base URL                        |
| `LLM_REASONING_EFFORT`          | no       | unset (model default)                           | Sent as `reasoning_effort` only when set                                  |
| `LLM_FALLBACK_MODEL`            | no       | unset (no fallback)                             | Second model, used on 429 / 5xx / timeout / invalid output                |
| `LLM_FALLBACK_BASE_URL`         | no       | same as `LLM_BASE_URL`                          | e.g. `https://generativelanguage.googleapis.com/v1beta/openai` for Gemini |
| `LLM_FALLBACK_API_KEY`          | no       | `LLM_API_KEY`, only if the base URL is the same | Key for the fallback provider                                             |
| `LLM_FALLBACK_REASONING_EFFORT` | no       | unset                                           | Sent only when set                                                        |
| `LLM_FALLBACK2_*`               | no       | inherits URL and key from `LLM_FALLBACK_*`      | Optional third model (`_MODEL`, `_BASE_URL`, `_API_KEY`, ...)             |
| `LLM_TIMEOUT_MS`                | no       | `8000`                                          | Timeout per LLM call                                                      |
| `LLM_TOTAL_BUDGET_MS`           | no       | `22000`                                         | Total LLM time per request (keeps every request under the 30 s limit)     |
| `LLM_MAX_TOKENS`                | no       | `2048`                                          | Output token limit per call                                               |
| `LLM_JSON_MODE`                 | no       | `true`                                          | Request `response_format: json_object`                                    |
| `PORT` / `HOST`                 | no       | `8000` / `0.0.0.0`                              | Listen address                                                            |

If no LLM is configured, the service still starts and returns valid schedules, but every note is reported as `no_op`.

---

## 4. Architecture

```
POST /optimize-energy
  │
  ├─ 1. Request validation      400 malformed/structural, 422 semantically impossible
  ├─ 2. LLM interpreter         one batched LLM call for all notes (note text only)
  ├─ 3. Guardrails              deterministic validation + normalization of every LLM result
  │      └─ repair loop         only rejected notes are re-asked, with the exact error; then fallback model
  ├─ 4. Directive → limits      per-hour effective solar, min SoC, charge/discharge caps, grid caps
  ├─ 5. HiGHS LP optimizer      exact minimum-cost schedule
  ├─ 6. Response assembly       one action per hour, totals computed from the returned plan
  └─ 7. Final replay            independent re-check of every GridWise rule and every directive
```

Code layout:

```
src/
  server.js, app.js             startup (solver warm-up, graceful shutdown), Express wiring
  routes/  controllers/         GET /health, POST /optimize-energy
  middlewares/  validators/     request schema checks, JSON error handling
  prompts/interpreter.prompt.js the LLM system prompt
  services/
    interpreter.service.js      batching, repair loop, fallback, cache, time budget
    llm.client.js               OpenAI-compatible fetch client (no SDK)
    guardrails.service.js       LLM output → spec-exact directive_interpretation entry
    limits.service.js           directives → per-hour numeric limits
    optimizer.service.js        LP construction and HiGHS solve
    response.service.js         totals and plan_summary
    replay.service.js           final validator
    energy.service.js           the pipeline above
test/                           unit, fuzz, API, load tests and LLM evals
examples/                       sample request and real response
scripts/llm-smoke.js            checks that the configured models exist and respond
```

---

## 5. LLM role (model and provider)

The language model is the **only** component that reads operator notes. Its structured output directly produces the constraints the optimizer uses.

- **Providers:** OpenAI and Google Gemini (through its OpenAI-compatible endpoint), both called through the Chat Completions API with plain `fetch`.
- **Models, tried in this order:**
  1. `gpt-4o-mini` (OpenAI): primary; paid API with high rate limits.
  2. `gemini-3.5-flash-lite` (Gemini): a different provider, so one provider's outage cannot take down every model.
  3. `gemini-3.1-flash-lite` (Gemini): a separate Gemini model with its own quota.
- **Keys:** each provider uses its own key. A fallback reuses the previous model's key only when its base URL is the **same**, so an OpenAI key is never sent to Gemini or the other way round.
- **Settings:** `temperature: 0`, JSON mode, system prompt in [src/prompts/interpreter.prompt.js](src/prompts/interpreter.prompt.js).

**Single call, then repair:**

1. All notes of a request go to the model in **one** call as `{"notes":[{"index":0,"text":"..."}]}`. The model returns `{"results":[...]}`, one object per note. This keeps normal usage at 1 LLM call per request, which matters under free-tier rate limits.
2. Every result passes through the guardrails. Accepted notes are kept.
3. Only the **rejected** notes are sent back, together with the model's previous output and the exact validation error, for example `remaining_percent + reduction_percent must equal 100`.
4. On HTTP 429, 5xx or a timeout, the service switches to the next model immediately. Auth errors (401/403/404) disable that model for the request. All attempts share a 22 s budget.
5. If every attempt fails, the affected note becomes a controlled `no_op` with an explanation. The service never crashes and never invents a directive.

**The model reports raw facts; code does the arithmetic.** The model returns `windows` (`start_hour`/`end_hour`), `remaining_percent` **and** `reduction_percent`, `minimum_energy_kwh` **or** `reserve_percent_of_capacity`, and `max_grid_kwh`. Code then:

- expands windows with the start hour included and the end hour excluded (1 PM to 3 PM → `[13,14]`)
- checks that remaining + reduction = 100, which catches "drop **to** 20%" versus "drop **by** 20%"
- converts a percentage reserve to kWh using the request's battery capacity

The model is sent **only the note text**. It never sees demand, solar, tariff or battery values, so it cannot change them.

Validated LLM results are cached in memory by normalized note text, so repeated notes cost no LLM call. Percentage reserves are re-normalized against each request's own battery.

---

## 6. Guardrails

Every LLM result is treated as untrusted until all of these pass ([guardrails.service.js](src/services/guardrails.service.js)):

| Guardrail           | Rule                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Parseable output    | One JSON object with exactly one result per note; results are realigned by `index` if reordered                     |
| Allowed types       | `directive_type` must be one of the 6 supported types, otherwise rejected                                           |
| Note mapping        | `note_index` comes from array position in code, never from the LLM; one entry per note, in order                    |
| `applies` semantics | Set by code: `no_op` gives `applies:false` and `structured_adjustment:null`; every other type gives `applies:true`  |
| Hours               | Windows must satisfy `0 ≤ start < end ≤ 24` (split at midnight); the result is unique, sorted integers 0–23         |
| Solar factor        | 0 ≤ factor ≤ 1; remaining and reduction percentages must sum to 100                                                 |
| Battery reserve     | Finite, ≥ 0 and ≤ battery capacity; percentages converted in code                                                   |
| Grid cap            | Finite and ≥ 0                                                                                                      |
| No invention        | `structured_adjustment` is rebuilt from whitelisted keys only; any extra LLM fields (e.g. `demand_kwh`) are dropped |
| Final replay        | After optimization the finished schedule is re-verified; see section 7                                              |

---

## 7. Optimizer (HiGHS linear program)

The solver is **HiGHS**, used through the `highs` npm package (WebAssembly build). One LP with 120 variables solves in about 1–3 ms. The solver is loaded at startup.

For each hour `h`:

- **Variables:** `grid[h] ≥ 0`, `sol[h] ∈ [0, effSolar[h]]`, `chg[h] ∈ [0, maxCharge[h]]`, `dis[h] ∈ [0, maxDischarge[h]]`, `soc[h] ∈ [minSoc[h], capacity]`
- **Objective:** minimize `Σ grid[h] × tariff[h]`
- **Energy balance:** `grid[h] + sol[h] + dis[h] − chg[h] = demand[h]`
- **Battery transition:** `soc[h] = soc[h−1] + chg[h] − dis[h]`, with `soc[−1] = initial_energy_kwh`
- **End-of-day neutrality:** `soc[23] = initial_energy_kwh`

How each directive changes the model ([limits.service.js](src/services/limits.service.js)):

| Directive                 | Effect on the LP                                   |
| ------------------------- | -------------------------------------------------- |
| `solar_reduction`         | `effSolar[h] = solar_kwh[h] × factor`              |
| `minimum_battery_reserve` | `minSoc[h] = max(base minimum, directive minimum)` |
| `no_charge_window`        | `maxCharge[h] = 0`                                 |
| `no_discharge_window`     | `maxDischarge[h] = 0`                              |
| `max_grid_window`         | `grid[h] ≤ max_grid_kwh`                           |

**Post-processing:**

- Simultaneous charge and discharge in one hour are netted into a single action. This is always valid because only their difference enters the balance.
- `grid_kwh` is recomputed from the balance equation and values are rounded to 6 decimals.
- Battery energy is recomputed from the reported actions.
- `total_grid_kwh`, `total_cost_bdt` and `peak_grid_kwh` are computed from the returned plan.

**Final replay** ([replay.service.js](src/services/replay.service.js)) independently re-checks:

- the 24 hours
- non-negative, finite values
- energy balance
- battery transitions, bounds and rate limits
- `idle` meaning `battery_kwh = 0`
- effective solar
- every directive, checked straight from `directive_interpretation`
- end-of-day neutrality
- the totals

If any check fails, the service returns 500 instead of an invalid plan; this has never happened in testing. If the directives make the problem infeasible, the service returns 422 `infeasible_after_directives`.

---

## 8. API summary

| Request                                                                                                             | Response                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                                       | `200 {"status":"ok"}`                                                                                                                    |
| `POST /optimize-energy` (valid)                                                                                     | `200` with `scenario_id`, `directive_interpretation`, `hourly_plan`, `total_grid_kwh`, `total_cost_bdt`, `peak_grid_kwh`, `plan_summary` |
| Malformed JSON, wrong types, not 24 unique hours 0–23, not 1–3 non-empty notes, missing battery fields, body > 1 MB | `400 {"error": "..."}`                                                                                                                   |
| Negative demand/solar, inconsistent battery, values beyond ±1e9, infeasible directives                              | `422 {"error": "..."}`                                                                                                                   |
| Unknown route                                                                                                       | `404 {"error":"not_found"}`                                                                                                              |
| Unexpected failure                                                                                                  | `500 {"error":"internal_error"}`, never a stack trace                                                                                    |

Other request details:

- Hours may arrive in any order.
- Unknown extra fields are ignored.
- JSON is accepted even without a `Content-Type` header.
- `plan_summary` is a deterministic template, so it adds no LLM latency.

---

## 9. Testing

```bash
npm test               # 148 offline tests, no LLM calls, about 10 s
npm run llm:smoke      # checks that every configured model exists and responds
npm run eval:notes     # 42 paraphrased notes and distractors against the real LLM (about 14 calls)
npm start              # then, in a second terminal:
npm run eval:samples   # all 10 public samples end-to-end against a running server
npm run eval:samples -- https://<LIVE_BASE_URL>   # same against the deployed service
```

The eval scripts wait 4 s between LLM calls (`EVAL_DELAY_MS`) to stay under free-tier rate limits.

Latest results:

| Suite                                       | Result                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                  | 148/148 pass                                                                                                                                                     |
| `eval:notes`                                | 42/42 exact (type, hours, value) with `gemini-3.5-flash-lite`                                                                                                    |
| `eval:samples` (local and Docker container) | 10/10 pass: interpretation matches the reference, schedule replays clean against the ground-truth directives, cost equals the optimal reference; p95 about 2.2 s |

What `npm test` covers:

- **Optimizer correctness:** 1,500 random scenarios compared against an independent dynamic-programming solver with no shared code. Every optimal cost and every infeasibility verdict matches.
- **Hand-computed toy scenarios:** T1–T10.
- **Public samples:** all 10 reach the optimal cost using the reference interpretations.
- **Extreme values:** zero-size battery, negative tariffs, values near 1e9, long decimals, overlapping directives.
- **Final replay:** deliberately broken plans are detected.
- **Guardrails:** unit tests for every rule.
- **Interpreter against a fake LLM:** batching, repair, 429/503/timeout fallback, cache, secrets never logged.
- **API errors:** 62 malformed, semantic and edge-case requests.
- **Load:** 500 concurrent requests, mixed valid and invalid traffic, and 3,000 sequential solves.

---

## 10. Interpretation conventions

- Time windows include the start hour and exclude the end hour; midnight is 0 as a start and 24 as an end. Windows that cross midnight are split.
- A single time ("at 6 PM") means one hour; "for N hours starting at X" means `[X, X+N)`; "all day" or no stated time means hours 0–23.
- `factor` is the usable fraction that remains: an 80% reduction gives `factor = 0.2`.
- "Today", "tonight" and "tomorrow" refer to the planned day. Notes about other weeks or months, past events, or energy news that is not one of the 5 constraint types (demand forecasts, tariff changes) are `no_op`.
- When directives overlap, which the spec does not define: solar factors multiply, the highest reserve wins, the lowest grid cap wins, and no-charge/no-discharge windows are combined.

## 11. Known limitations

- The interpretation depends on the LLM providers being available and within quota. If every configured model fails within the time budget, the affected notes are returned as `no_op`; the schedule stays valid but ignores those notes.
- The note cache is in memory and per process, so it is not shared between instances or kept across restarts.
- Directive combinations that make the problem infeasible return 422 rather than a partial schedule. Organizer scenarios are stated to be feasible.
- Numeric inputs are limited to ±1e9. Negative tariffs are accepted, since the spec does not forbid them.
- On Windows client editions, the OS limits queued TCP connections to about 200, so over 500 truly simultaneous connections can be refused locally. Linux, which the container and deployment use, is unaffected.

## 12. Security and secret handling

- API keys come only from environment variables. `.env` is listed in `.gitignore` and `.dockerignore`; only `.env.example`, which has empty values, is committed.
- The key is sent only in the `Authorization` header to the LLM provider. It is never logged, never included in responses, and never baked into the Docker image; tests assert this.
- Logs contain only model labels, HTTP status codes and validation reasons. Error responses are short JSON codes with no stack traces or HTML.
- The LLM receives only operator-note text. Only the synthetic challenge data from the request is processed.

## 13. Dependencies and credits

| Dependency                                                                          | Use                          | License        |
| ----------------------------------------------------------------------------------- | ---------------------------- | -------------- |
| [Express 4](https://expressjs.com/)                                                 | HTTP server                  | MIT            |
| [highs](https://www.npmjs.com/package/highs) (HiGHS solver compiled to WebAssembly) | Linear programming           | MIT            |
| [Prettier](https://prettier.io/) (dev only)                                         | Code formatting              | MIT            |
| Node.js built-ins (`fetch`, `node:test`)                                            | LLM HTTP client, test runner | MIT            |
| OpenAI API and Google Gemini API                                                    | Operator-note interpretation | Provider terms |

**AI assistance:** Claude Code (Anthropic) was used as a coding assistant during development. The architecture, the problem analysis and the final review of all code are the team's own work.
