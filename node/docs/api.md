# Mobile API

Base URL: `http://127.0.0.1:8787`. Send `X-API-Key: YOUR_API_KEY` on every request except `GET /health`. Responses use JSON. Listing and detail reads are read-only; the job action endpoints below update job status.

## Account and plans

`GET /me` returns the authenticated user, current plan, point balance, SaaS switch, and current UTC month's usage. `GET /usage/summary?days=30` returns per-kind call and token totals for 1–365 days. `GET /plans` lists available plans. All require the same API key.

Job listings, details, counts, and actions are scoped to the authenticated user's `user_jobs` rows. Shared job source data remains common; a job with no row for that user returns `404 NOT_FOUND`. The owner continues to receive its migrated rows and retains the legacy API response shape.

```sh
curl -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/me
curl -H 'X-API-Key: YOUR_API_KEY' 'http://127.0.0.1:8787/usage/summary?days=30'
curl -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/plans
```

See [saas.md](saas.md) for point limits, costs, errors, and configuration.

## AI job actions

`POST /jobs/:id/evaluate`, `/proposal`, and `/estimate` generate a result for the authenticated user's job. Bodies are optional JSON. `{ "regenerate": true }` forces a new generation; otherwise an existing result is returned free with `cached: true`. Proposal accepts `{ "skip_evaluation": true }` to bypass the evaluation prerequisite. Responses have `{ job_id, kind, cached, result, usage, job }`; `usage` is null for cached results and otherwise contains points, model, input/output token counts, and nullable USD cost. Proposal generation never sends the text; it saves it for review and changes `sent` to `approved` where allowed.

Errors include `GEMINI_NOT_CONFIGURED` (503), `GEMINI_TIMEOUT` (504), `GEMINI_RATE_LIMITED` (503), `GEMINI_UNAVAILABLE` / `GEMINI_BAD_RESPONSE` (502), `PROFILE_REQUIRED` (422), `EVALUATION_REQUIRED` / `EVALUATION_SKIP` / `ALREADY_RUNNING` (409), plus SaaS guard codes. Set Gemini settings in `node/.env`; no credentials are returned by API responses.

## Health

`GET /health`

```sh
curl http://127.0.0.1:8787/health
```

```json
{"ok":true,"version":"1.0.0","time":"2026-11-10T10:00:00.000Z"}
```

## List jobs

`GET /jobs?status=new&source=freelancer&tag=flutter&min_score=5&search=mobile&since=2026-01-01&limit=50&offset=0&sort=newest`

```sh
curl -H 'X-API-Key: YOUR_API_KEY' 'http://127.0.0.1:8787/jobs?status=new&limit=50&sort=newest'
```

All parameters are optional. `status`: `new`, `sent`, `approved`, `applied`, `rejected`, `skipped`; `source`: `freelancer`, `mostaql`, `khamsat`; `tag`: a configured tech tag; `min_score`: number; `search`: case-insensitive literal substring in title or description; `since`: ISO date/time, filtering by creation time; `limit`: default 50, maximum 200; `offset`: default 0; `sort`: `score`, `newest` (default), or `posted`.

```json
{"items":[{"id":42,"source":"freelancer","external_id":"abc","title":"Flutter app","url":"https://example.test/job","budget":"$500","score":7.5,"score_line":"🔥 قوي","status":"new","tags":["flutter"],"currency":"USD","bid_count":4,"bid_avg":125,"posted_at":"2026-11-09T09:00:00Z","applied_at":null,"created_at":"2026-11-09T09:10:00Z","has_proposal":false,"has_estimate":false,"prototype_url":null}],"total":1,"limit":50,"offset":0}
```

## Job details

`GET /jobs/42`

```sh
curl -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/jobs/42
```

Returns the list fields plus description, proposal, evaluation, estimate and stats.

```json
{"id":42,"source":"freelancer","external_id":"abc","title":"Flutter app","url":"https://example.test/job","budget":"$500","score":7.5,"score_line":"🔥 قوي","status":"new","tags":["flutter"],"currency":"USD","bid_count":4,"bid_avg":125,"posted_at":"2026-11-09T09:00:00Z","applied_at":null,"created_at":"2026-11-09T09:10:00Z","has_proposal":false,"has_estimate":false,"prototype_url":null,"description":"Build an app","proposal":null,"evaluation":null,"estimate":null,"stats":{"bid_count":4,"bid_avg":125,"currency":"USD","posted_at":"2026-11-09T09:00:00Z"}}
```

## Counts

`GET /stats/counts`

```sh
curl -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/stats/counts
```

```json
{"by_status":{"new":1,"sent":0,"approved":0,"applied":0,"rejected":0,"skipped":0},"by_source":{"freelancer":1},"total":1}
```

## Scanner controls

Scanning is disabled by default (`settings.json` starts with `scan_enabled: false`). When enabled, the scheduler waits `interval_minutes` plus a random 0–5 minute jitter before each cycle. The scanner saves newly matched jobs with status `sent` immediately so the action endpoints can operate on them. A scan run does not send Telegram messages.

`GET /scan/status`

```sh
curl -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/scan/status
```

```json
{"running":false,"started_at":null,"enabled":false,"interval_minutes":60,"next_run_at":null,"last_scan":null}
```

`POST /scan/run` starts a manual scan in the background; the optional request body is ignored. It returns `202` immediately. If a scan already holds the shared scan lock, it returns `409` with code `SCAN_RUNNING`.

```sh
curl -X POST -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/scan/run
```

```json
{"started":true,"started_at":"2026-11-10T10:00:00.000Z"}
```

`POST /scan/settings` accepts a JSON body with optional `enabled` (boolean) and `interval_minutes` (integer from 5 through 1440). Values are persisted atomically and the schedule is recalculated immediately. Invalid JSON/values return `400 INVALID_PARAMETER`; bodies over 10 KB return `413`.

```sh
curl -X POST -H 'X-API-Key: YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{"enabled":true,"interval_minutes":60}' http://127.0.0.1:8787/scan/settings
```

```json
{"running":false,"started_at":null,"enabled":true,"interval_minutes":60,"next_run_at":"2026-11-10T11:03:00.000Z","last_scan":null}
```

`last_scan` is the most recent in-memory summary with `started_at`, `finished_at`, `duration_ms`, `trigger`, per-source `fetched`, `new_candidates`, `filtered_out`, `details_failed`, `details_unavailable`, `new_saved`, `stats_fetched`, `would_save`, `would_skip_filtered`, `would_skip_details_failed`, and structured `errors`, plus totals. It is cleared when the API process restarts. Khamsat can return list-level jobs when detail pages are unavailable; these remain eligible for saving and are counted in `details_unavailable` rather than `details_failed`.

## Freelancer radar

The radar is disabled by default and persists its `enabled` flag as `radar_enabled` in `settings.json`. It scans Freelancer queries in rotation, using the shared scan lock and the same job processing pipeline as the scanner. Defaults are a 120-second interval (minimum 60), two queries per cycle, maximum 3 bids, minimum score 6, maximum age 30 minutes, and a persisted cap of 6 alerts per hour. `RADAR_QUIET_HOURS` accepts `start-end` hours in `Africa/Cairo` time; an empty value disables quiet hours.

`GET /radar/status` reports the enabled state, current cycle, interval, last cycle time/result, hourly alert count and cap, next cycle time, and current backoff. `POST /radar/on` and `POST /radar/off` persist the setting and return the same status object.

```sh
curl -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/radar/status
curl -X POST -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/radar/on
curl -X POST -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/radar/off
```

An eligible saved job emits `radar_alert` with the normal compact job event fields plus `bid_count`, `bid_avg`, and `age_minutes`. The `proposal_ready` event remains reserved; this step does not generate proposals.

Database timestamps such as `created_at`, `posted_at`, and `applied_at` are serialized by the API and SSE stream as ISO-8601 UTC strings ending in `Z`; their database values remain unchanged.

## Realtime events

`GET /events` opens an authenticated Server-Sent Events stream. Send `X-API-Key` as a request header. The server flushes the response headers and an initial comment immediately; comment lines beginning with `:` are keep-alives and can be ignored.

```sh
curl -N -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/events
```

Each event uses this exact framing, with compact one-line JSON after `data:`:

```text
id: 17
event: new_job
data: {"id":42,"source":"freelancer","external_id":"abc","title":"Flutter app","url":"https://example.test/job","budget":"$500","score":7.5,"score_line":"🔥 قوي","tags":["flutter"],"status":"sent","created_at":"2026-11-09T09:10:00Z","posted_at":"2026-11-09T09:00:00Z"}

```

Event types:

- `new_job`: a newly saved job with status `sent`. Payload fields are `id`, `source`, `external_id`, `title`, `url`, `budget`, `score`, `score_line`, `tags`, `status`, `created_at`, and `posted_at`. It does not include the description or proposal.
- `scan_finished`: the same scan summary returned as `last_scan` by `GET /scan/status`, including `totals` and `per_source`.
- `reset`: sent when the requested replay cursor is older than the retained event history. For example: `data: {"reason":"buffer_overflow","action":"refetch_jobs"}`. Refetch `GET /jobs` and reconnect using the reset event's `id`.
- `radar_alert`: a saved Freelancer job meeting the radar bid, score, age, hourly-cap, and quiet-hours rules. It includes the `new_job` fields plus `bid_count`, `bid_avg`, and `age_minutes`.
- `proposal_ready` is reserved for a later step and is not emitted yet.

Every event payload includes `user_id`. `new_job` and `radar_alert` are sent to each user who received a `sent` row; `scan_finished` is owner-only (`user_id: 1`). Replay applies the same user filter, so events for another user are never returned. Event IDs and the ring buffer remain global.

On reconnect, send the last received event ID using the `Last-Event-ID` header. The server replays buffered events after that ID in order. The in-memory replay buffer defaults to 500 events (`EVENTS_BUFFER_SIZE`); keep-alive comments default to every 25 seconds (`EVENTS_KEEPALIVE_SECONDS`), with a maximum of 20 simultaneous clients (`EVENTS_MAX_CLIENTS`).

Flutter clients can send `X-API-Key` using an HTTP streaming client. Browser `EventSource` cannot set custom headers, so a website must use fetch-based streaming for now.

## Job actions

The body is optional and ignored. These actions follow the Python callback status guards: reject only from `sent`; approve only from `sent`; apply only from `approved`. Repeated or otherwise disallowed transitions return `409 STATUS_CONFLICT` with the current status (for example: `Cannot mark job as applied while its current status is "sent"`). Applying sets `applied_at` only if it is empty; a repeat never replaces it. `applied_at` is included in list, detail and action responses as stored, or `null` when empty.

```sh
curl -X POST -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/jobs/42/reject
curl -X POST -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/jobs/42/approve
curl -X POST -H 'X-API-Key: YOUR_API_KEY' http://127.0.0.1:8787/jobs/42/applied
```

Each successful action returns the same full-job JSON object as `GET /jobs/:id`, with `status` updated. For example, reject returns:

```json
{"id":42,"source":"freelancer","external_id":"abc","title":"Flutter app","url":"https://example.test/job","budget":"$500","score":7.5,"score_line":"🔥 قوي","status":"rejected","tags":["flutter"],"currency":"USD","bid_count":4,"bid_avg":125,"posted_at":"2026-11-09T09:00:00Z","applied_at":null,"created_at":"2026-11-09T09:10:00Z","has_proposal":false,"has_estimate":false,"prototype_url":null,"description":"Build an app","proposal":null,"evaluation":null,"estimate":null,"stats":{"bid_count":4,"bid_avg":125,"currency":"USD","posted_at":"2026-11-09T09:00:00Z"}}
```

Errors use `{"error":{"code":"...","message":"..."}}`. For websites, set `CORS_ORIGINS` to a comma-separated list of exact origins (scheme, host and port); wildcard origins are never enabled. Requests without an `Origin` header, such as Flutter mobile requests, are allowed.
