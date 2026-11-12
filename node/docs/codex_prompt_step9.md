# Step 9 - Gemini endpoints (Node API)

You are working on the Node.js rewrite of an existing Python job-hunting bot. The Node project lives in the `node/` folder of the open project. Read this whole file before changing anything.

## 0. Hard rules

- Modify files ONLY inside `node/`. Never touch anything outside it.
- Never write to the Python `jobs.db`, the old `.env`, or `settings.json`. Never read, print, copy, or hardcode values from `node/.env`. Read config only through the existing config module (`process.env` via dotenv).
- Do not add Telegram or n8n to Node.
- Do not add dependencies. Use Node built-ins only (global `fetch`, `node:sqlite`). Current deps are `cheerio` and `dotenv`. Do not run `npm install`. You have no internet access.
- Do not change the SaaS structure, plan values, or prices. Do not change plan permissions (free plan: evaluate + estimate only; proposal/prototype/radar are for the owner to review later).
- Do not invent Gemini model prices. Cost is computed only from env-configured input/output prices; if they are not set, report usage tokens and leave cost empty/null.
- Do not rely on selectors, response fields, or API shapes that are not present in existing code or saved samples. If something is missing, say so in your report instead of guessing.
- Tests must be fully offline: fake fetch and local data only. Never call Gemini live in the test suite. Use temporary SQLite databases and close all connections before deleting them (Windows file-lock issue).
- Tests run from inside `node/` with `npm test` (or `node --test`). Never `node --test test`.

## 1. First, inspect the existing code

Before writing code, read the existing API server, router, config, db layer, SaaS guard (`guard.execute`), usage logging (`usage_events`), the radar/scanner code, and the existing tests. Follow their conventions (module style, error format, auth via `X-API-Key`, ISO UTC timestamps with `Z`). Reuse what exists; do not duplicate it.

## 2. Shared Gemini client

Create a shared Gemini client module that:

- Reads API key, model name, and optional price settings from config/env (never logs them).
- Enforces a minimum 5 second gap between calls (a shared queue/limiter, testable with an injectable clock/sleep).
- Handles HTTP 429 with limited retries and backoff (respect `Retry-After` if present), with a request timeout.
- Returns the generated text plus usage metadata (input/output tokens) and a cost value only when prices are configured.
- Takes an injectable `fetch` so tests can fake it.
- Surfaces clear typed errors (rate limited, timeout, bad response, auth) without leaking secrets.

## 3. Endpoints

Add, behind the existing `X-API-Key` auth:

- `POST /jobs/:id/evaluate`
- `POST /jobs/:id/proposal`
- `POST /jobs/:id/estimate`

Common behavior:

- Unknown job id returns 404, consistent with existing endpoints.
- If a stored result already exists for that job (for this user, using the `user_jobs` per-user state from SaaS S2), return it without calling Gemini and without charging or consuming anything. Stored results are free.
- New generation happens only when no stored result exists, or when the body contains `regenerate: true`.
- Add a per-job lock so two concurrent requests for the same job and same action never call Gemini twice; the second request waits for or reuses the first result, or gets a clear 409, whichever fits the existing conventions.
- Route every billable call through the existing SaaS guard (`guard.execute`): plan check, rate/day/credit limits, reserve credits before the call and refund them if it fails, and record a `usage_events` row. There must be no code path that bypasses the guard.

### evaluate

- Produces a `verdict` and a `reason`, following the logic of the original Python evaluator. Find the Python evaluation prompt/logic in the project's Python files (read only) and port its intent faithfully.
- Stores the result.

### proposal

- Requires a stored evaluation first, unless the request body explicitly says to skip it (for example `skip_evaluation: true`).
- On successful creation, set the job status to `approved`. Do not change `applied`; that only changes through the existing separate applied action. Proposals are never sent automatically; the owner reviews and sends them manually.
- Port the intent of the Python proposal prompt (read only).

### estimate

- Use the Python estimation logic: default rate 15 USD/hour, minimum 0.8, margin 1.25, and market comparison by currency group when data is available. Port from the Python code (read only); make these values configurable where the Python code does.
- A stored estimate is returned without calling Gemini.

## 4. Radar integration

After Gemini is available, the radar may request an automatic proposal for each alert:

- One Gemini call per alert at most.
- A failed proposal must never block or drop the radar alert itself.
- On success, include `proposal_ready` in the alert/event payload.
- Respect the SaaS guard and plan permissions here too; if the plan does not allow it, send the normal alert without a proposal.

## 5. Tests (offline)

Add tests covering at least:

- Rate limiter spacing (5s, with fake clock) and 429 retry/backoff.
- Evaluate, proposal, estimate happy paths with fake fetch.
- Stored result is returned with no Gemini call and no charge; `regenerate: true` forces a new call.
- Concurrent requests for the same job produce one Gemini call.
- Guard behavior: plan denial, limit exceeded, credit reserved then refunded on failure, `usage_events` written.
- Proposal requires evaluation; success sets status `approved` and leaves `applied` untouched.
- 404 for unknown jobs, 401 without key.
- Radar: proposal failure does not block the alert; `proposal_ready` present on success.
- Existing tests (72 before this step) must still pass.

## 6. Documentation

Update `node/docs/api.md` with the three endpoints, request/response shapes, error codes, and the `regenerate` behavior. Add any new env variable NAMES (not values) to `node/.env.example` if that file exists.

## 7. Final report

When finished, reply with a complete final report containing:

1. Every file you created or modified (full paths), and confirm each is inside `node/`.
2. Anything you touched that was not obviously in scope, and why.
3. The new env variable names introduced.
4. What you could NOT verify (you cannot run the tests on the owner's Windows machine; do not claim they pass).
5. Any assumptions you made, or places where the existing code did not match what this prompt expects.

END OF PROMPT
