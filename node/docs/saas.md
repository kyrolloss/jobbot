# SaaS foundation

This is a structure-only foundation: there is no checkout, payment provider, billing UI, or JWT. The current API key resolves to seeded owner user `1`; an ordered auth-provider list allows another provider to be added later. The guard is for new generations only. Callers should return stored results before invoking it.

## Shared jobs and per-user state

Job identity and source data remain shared in `jobs`; status, score, proposal, evaluation, estimate, prototype URL, and applied time live in `user_jobs`, keyed by `(user_id, job_id)`. Bid statistics, currency, tags, posting time, title, description, URL, budget, and creation time stay shared. Telegram `message_id` has no `user_jobs` equivalent and is retained only as a legacy `jobs` column. Indexes are `(user_id,status)`, `(user_id,created_at)`, and `(job_id)`.

At every database open, one `BEGIN IMMEDIATE` transaction performs `INSERT OR IGNORE ... SELECT` migration for rows missing an owner (`user_id=1`) state, copying the legacy per-user fields and converting timestamps to UTC ISO. Reopening is safe and never alters `jobs`. Insert and owner-column update triggers keep legacy writers and imports synchronized with owner state. Owner changes to status, score, proposal, evaluation, estimate, prototype URL, and applied time are dual-written to `jobs` during the compatibility period; other users never update those legacy columns. This mirror is for rollback and parity/import tooling and will be removed after those consumers are retired.

Scans fetch each platform once. New jobs always get an owner row. When SaaS is enabled, active non-owner users get rows only for sources whose `SOURCE_POLICY[source].saas` is true and only when their profile keyword list (if non-empty) or the broad global filter matches. A non-empty profile keyword list is treated as the user's positive match list; the global negative keyword exclusions apply only when falling back to the global filter. Per-user scores use the same scorer. Existing jobs are not backfilled for newly activated users; fan-out applies only to newly discovered jobs. Dry runs make no writes. Radar remains global and Freelancer-only and uses the same fan-out. Its alert cap remains global.

SSE events include `user_id`; streams replay only events for their principal. `scan_finished` is delivered to the owner only. The shared event ring and global IDs remain unchanged; a reset response identifies its user. The owner still sees all events as before.

`node scripts/verify_user_jobs.js <database-path>` opens the supplied path read-only and compares owner status counts and status/score/proposal/applied-time values against the legacy columns. It exits 1 on a mismatch. It does not run automatically against a live database.

## Tables

`users`, `plans`, `subscriptions`, `credit_ledger`, `usage_events`, `webhook_events`, and `user_profiles` are created idempotently alongside the existing jobs table. Indexes: `idx_subscriptions_user_created`, `idx_credit_ledger_user_created`, `idx_usage_events_user_created`, and `idx_webhook_events_provider_received`. Owner and the `free`, `pro`, and `power` plans seed once. Timestamps are ISO UTC strings. Source policy is stored in config for future fan-out: Freelancer enabled; Mostaql and Khamsat disabled.

## Limits and errors

Defaults: `SAAS_ENABLED=false`; `AI_RATE_LIMIT_PER_MINUTE=5`; monthly points free/pro/power `15/150/600`; daily caps `10/40/120`. Feature costs are estimate 1, evaluate 1, proposal 2, prototype 8. Free permits evaluate and estimate, with a 45-minute alert delay; paid plans permit the listed features with no delay. Owner and disabled SaaS bypass limits while usage is still recorded. Errors use `{"error":{"code":"...","message":"..."}}`: `PLAN_REQUIRED` (403), `RATE_LIMITED` and `DAILY_LIMIT_REACHED` (429), `INSUFFICIENT_CREDITS` (402, includes balance and cost). `RATE_LIMITED` includes `retry_after_seconds`.

Set `SAAS_ENABLED=true` in `node/.env` to enable plan checks and eligible per-user scan fan-out. Configure Gemini token costs there with `GEMINI_PRICE_PER_MTOK_INPUT` and `GEMINI_PRICE_PER_MTOK_OUTPUT` (both default to zero); price values are USD per million tokens. Optional `FEATURE_COSTS` is a JSON object. The current API-key provider still authenticates only the owner; future auth providers must supply a valid active user and plan assignment. `alert_delay_minutes`, minimum budget, countries, and portfolio are stored/planned but unused by fan-out. New users receive no old-job backfill. Do not enable for end users until authentication and user provisioning are connected.
