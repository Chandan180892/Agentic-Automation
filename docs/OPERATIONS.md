# Operating Autopilot

This covers running Autopilot for a team: deployment, configuration, scaling, monitoring, and what
to do when something goes wrong. The configuration reference is `.env.example`; every value there
is validated at boot by `src/lib/env.ts`.

## Architecture in one paragraph

Autopilot is one Next.js deployable backed by Postgres. Requests never run agents themselves: a run
is written as a **job** and a **worker** picks it up. The worker runs inside the web server by
default (`WORKER_MODE=inline`) and can be split out to scale separately. Jobs are claimed with a
lease (`FOR UPDATE SKIP LOCKED`), renewed while they work; a worker that dies stops renewing, and
the next sweep fails its job and run with a message saying so. Every model call goes through one
client (`src/lib/agents/llm.ts`) with timeouts, retries, refusal and truncation handling, prompt
caching, token accounting per run and a per-workspace daily budget. Nothing reaches Jira, Xray
or Bitbucket until a workspace owner or admin approves it, and every such decision is audited.

```
browser ──► Next.js (pages, server actions, /api/*) ──► Postgres ◄── worker(s)
                                   │                       ▲            │
                                   └── enqueue job ────────┘            ├──► Anthropic API
                                                                        └──► Jira · Xray · Bitbucket (approved writes only)
```

## Deploying

### Requirements

- Node 22+ (or the container image)
- Postgres 14+ (16 recommended)
- An OAuth app (Google or GitHub) for sign-in
- An Anthropic API key for live agents (without one, agents run on labelled simulators)

### Container

```bash
docker build -t autopilot .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://…" \
  -e AUTH_SECRET="$(openssl rand -base64 32)" -e AUTH_URL="https://autopilot.example.com" -e AUTH_TRUST_HOST=true \
  -e AUTH_GITHUB_ID=… -e AUTH_GITHUB_SECRET=… \
  -e ANTHROPIC_API_KEY=… \
  autopilot
```

On start the container runs `prisma migrate deploy`, which applies only reviewed migration files
and takes an advisory lock, so several replicas starting together is safe. It never rewrites the
schema destructively.

### Render

`render.yaml` provisions the web service and a Postgres database. After the first deploy, set
`AUTH_URL` to the service URL, add OAuth credentials and `ANTHROPIC_API_KEY`, then set
`ALLOW_DEMO_LOGIN=false`.

### Locally, production-shaped

```bash
docker compose up --build                   # Postgres + app with the inline worker
docker compose --profile scale up --build   # + a separate worker container
```

## Configuration that matters in production

| Setting | Why |
|---|---|
| `AUTH_SECRET` | ≥ 32 characters or the server refuses to start. Rotating it signs everyone out. |
| `AUTH_URL` | Must be the public URL, or OAuth callbacks and secure cookies break. |
| `ALLOW_DEMO_LOGIN` | Leave unset. When `true`, anyone can enter a shared workspace; the server warns at every boot. |
| `AGENT_DAILY_TOKEN_BUDGET` | Caps spend per workspace per UTC day (default 3,000,000 tokens). When hit, agent steps fail with a message naming the cap; nothing half-runs silently. |
| `ANTHROPIC_MODEL` | Default `claude-sonnet-5`. Models that reject a forced tool choice (`claude-opus-5-5`, `claude-fable-5-1`) are handled automatically with a strict tool and `auto` choice. |
| `WORKER_MODE`, `WORKER_CONCURRENCY` | See scaling below. |
| `EVENT_RETENTION_DAYS` | Log lines and finished jobs are pruned hourly. Lessons, audit entries, runs and proposals are kept. |

## Scaling

- **One deployable (default).** `WORKER_MODE=inline`; each web replica also works the queue.
  Fine until agent work competes with page latency.
- **Separate workers.** Set `WORKER_MODE=off` on web replicas. Run workers from the same image
  with `WORKER_MODE=inline` and no traffic routed to them, or `npm run worker` outside a container.
  Any number of workers can share the queue; `WORKER_CONCURRENCY` sets jobs per process.
- Only one autopilot runs per workspace at a time, and only one sprint-wide pipeline per sprint —
  enforced by a unique key in the database, not by a check that two requests could both pass.

## Monitoring

| Endpoint | Use |
|---|---|
| `GET /api/health` | Liveness. 200 whenever the process serves. |
| `GET /api/ready` | Readiness. 503 unless the database answers, migrations are applied and a worker has checked in within a minute. Reports queue depth (`jobs.queued`, `jobs.running`) for backlog alerts. |

Logs are one JSON object per line in production. Useful messages to alert on:

| `msg` | Meaning |
|---|---|
| `job interrupted` | A worker died mid-job; the run was failed and can be re-run. Frequent occurrences mean crashes or deploys without draining. |
| `model call failed` | After SDK retries. `retryable: true` means rate limits or upstream errors. |
| `request failed` | An uncaught error in a page, action or route. The `digest` matches the reference shown to the user. |
| `database error` | Anything other than the expected unique-key conflicts the queue uses. |

Every `model call` line carries `input`, `output` and `cacheRead` token counts; the same totals are
stored per run (`Run.inputTokens` and friends) for cost reporting.

## Runbook

**A run shows "Interrupted … Run it again."** The worker executing it stopped (deploy, crash, OOM).
Nothing was published — publishing only ever happens on an explicit approval. Start the run again.
To avoid it during deploys, give containers a stop timeout of at least 30 s: on `SIGTERM` the worker
stops claiming and waits up to 25 s for running jobs.

**Runs stay "queued".** No worker is alive. `/api/ready` will say so. Check `WORKER_MODE` and the
worker processes' logs for `worker started`.

**"The workspace has used … daily model tokens."** The budget did its job. Raise
`AGENT_DAILY_TOKEN_BUDGET` or wait for 00:00 UTC.

**"Too many agent runs started in the last minute."** Per-workspace rate limit
(`ACTION_RATE_LIMIT_PER_MINUTE`).

**"Only a workspace owner or admin can …"** Publishing, integrations and lesson decisions need the
owner or admin role (`Membership.role`).

**Publishing failed.** The proposal is marked `failed` with the Atlassian error and can be retried
from the same button. A publish is claimed atomically, so a double click never writes twice.

## Database changes

1. Edit `prisma/schema.prisma`.
2. `npm run db:migrate -- --name what_changed` — creates a migration under `prisma/migrations`.
3. Review the SQL, commit it with the schema change.
4. Deploys apply it with `prisma migrate deploy`. CI fails if the schema and migrations disagree.

Back up Postgres with your provider's point-in-time recovery. Everything Autopilot knows lives in
the database; the containers are stateless.
