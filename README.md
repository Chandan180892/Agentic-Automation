# Gantry

**Sprint in. Green out.**

Gantry reads your **Jira** stories, walks each one through a chain of six sub-agents, and proposes
**Xray** test cases and a **Bitbucket** branch and pull request. Nothing is written to your systems
until you approve it.

The **Autopilot** closes the loop: it plans the sprint, automates every story, executes the tests,
heals what drifted, reviews each acceptance criterion against the evidence, reports, and **learns** —
so the next cycle makes fewer of the same mistakes. You watch all of it live.

- **Try it in the browser:** https://chandan180892.github.io/Agentic-Automation/ — the agents run in your browser (simulated), no setup
- **Screen prototype:** `docs/prototype.html`
- **Stack:** Next.js 16 (App Router, FE + BE in one deployable), Auth.js v5, Prisma, Anthropic SDK
- **Integrations:** Jira Cloud, Xray Cloud, Bitbucket Cloud

---

## The agents

| Agent | Role | In → out |
|---|---|---|
| `sprint-planner` | Planning | backlog → sprint plan |
| `qe-pipeline` | Orchestrator | Jira story → Xray tests + Bitbucket PR |
| `qe-auto-heal` | Repair, one spec | failure → verified patch |
| `batch-heal` | Repair, fleet | *n* failures → one PR |
| `qe-insights` | Analysis | run history → signals |
| `requirements-reviewer` | Review | criteria + results → traceability verdict |
| `cycle-reporter` | Report | cycle metrics → report |
| `learner` | Learning | cycle evidence → lessons |

### Inside `qe-pipeline`

One Jira story walks six sub-agents, each with a typed input, a typed output, and one job:

| # | Sub-agent | What it does |
|---|---|---|
| 1 | `story-analyzer` | Turns the story into testable behaviours; separates genuine ambiguity from the merely unstated |
| 2 | `clarify` | Writes one answerable question per ambiguity, each with a suggested default. **Stops the pipeline** when a wrong guess would test the wrong thing |
| 3 | `asset-resolver` | Reads the Bitbucket repo to find fixtures and page objects that already exist, so the suite is extended rather than duplicated |
| 4 | `spec-author` | Writes complete runnable files against the repo's own conventions, plus Xray cases with real steps and expected results |
| 5 | `verifier` | Maps every acceptance criterion to the test covering it, and hunts placeholders, bad imports and assertions that cannot fail |
| 6 | `reviewer` | The gate. Approves, or sends the work back — and writes the pull request |

**It converges rather than stalling.** When the verifier objects, spec-author revises and the
verifier re-checks, up to twice. When `clarify` hits a blocking ambiguity the run stops and says
what it needs, instead of guessing.

Every stage inherits three house rules:

1. **Never invent a requirement.** Missing criteria become questions, never quiet guesses.
2. **Never weaken a test to make it pass.** Skipping, quarantining, or loosening an assertion is
   not a fix.
3. **Be specific.** Name the criterion, the file, the selector.

Outputs come back through a forced tool call, so a result either matches the sub-agent's schema
or is rejected before it reaches your database.

### Nothing is written without approval

A run produces **proposals**, not writes. Approving one in the UI is the only code path in the
app that mutates Jira, Xray or Bitbucket:

| Proposal | What approving it does |
|---|---|
| `jira-comment` | Posts `clarify`'s questions on the story |
| `jira-bug` | Files an application defect the autopilot found, linked to its story |
| `xray-tests` | Creates the Xray test cases and records their keys |
| `bitbucket-branch` | Commits the files to a branch and opens the pull request |

### Simulator mode

With no `ANTHROPIC_API_KEY` set, every agent and sub-agent falls back to a deterministic built-in
simulator, and the result is labelled `simulated` all the way to the UI. Storage, stages, proposals
and review are still real, so a fresh clone is fully explorable before anyone configures a key.

Each Atlassian client degrades the same way: unconfigured, the pipeline still runs and the stage
log says which system it could not reach — `asset-resolver`, for instance, plans assets without
the repo's history and says so, rather than pretending it looked.

### Demo sign-in

OAuth is the real way in, but a brand-new deployment has no OAuth client yet — which would leave
the app behind a door nobody can open. Set `ALLOW_DEMO_LOGIN=true` and the login page offers a
shared demo workspace instead.

It is off unless you switch it on, and the page says plainly what it is: **everyone who signs in
this way lands in the same workspace and can see each other's work.** Turn it off once real
sign-in is configured.

---

## Autopilot — the self-learning loop

**Autopilot** in the app runs one cycle over a sprint and streams it live:

```
 recall → plan → automate → execute → heal → review → report → learn
    ↑                                                            │
    └──────────── lessons feed the next cycle's agents ──────────┘
```

| Phase | Who | What happens |
|---|---|---|
| Recall | memory | Loads the workspace's lessons and injects each into the agent it is scoped to |
| Plan | `sprint-planner` | Sizes, orders and commits the sprint; drafts missing acceptance criteria |
| Automate | `qe-pipeline` | Each committed story through the six sub-agents |
| Execute | executor | Runs every generated test |
| Heal | `qe-auto-heal` | Patches selector and timing drift and re-runs; escalates application defects untouched |
| Review | `requirements-reviewer` | Every acceptance criterion judged **met / not met / untested / blocked** from execution evidence |
| Report | `cycle-reporter` | Verdict first, then what the agents fixed themselves, what needs a person, and the trend |
| Learn | `learner` | Reduces the cycle's heals, revisions and defects to root causes, and stores one lesson per cause |

The live view (`/autopilot/<id>`) shows a **map of the agents** with the one holding the work
highlighted (down to the pipeline sub-agent), the phases, one merged log from every agent in the
cycle, each story's tests (first run → after heal), the requirements matrix, proposed Jira bugs,
the report and what was learned. `/autopilot` shows the **learning curve** across cycles and the
workspace's **memory**, with each lesson's confidence history.

**Run until stable** keeps starting cycles until one learns nothing new — no new lesson, nothing
healed, nothing revised — then stops by itself (at most `AUTOPILOT_MAX_CYCLES`, default 5). The live
view follows it from cycle to cycle, and **Stop after this cycle** ends it early.

### People stay in charge

- **Lesson approval.** Set *New lessons* to *wait for my approval* and a new lesson is `proposed`:
  no agent sees it until someone approves it. A rejected lesson stays rejected even when its
  evidence comes back. A run-until-stable that can only improve through a pending lesson stops and
  says so, instead of repeating itself.
- **Defects become Jira bugs — once.** Every criterion that fails on the application becomes one
  proposed `jira-bug` publication, carrying the criterion, the test and the failure, and linked to
  the story when filed. Later cycles reference the existing proposal instead of proposing it again.
  As with every other write, nothing reaches Jira until you approve it.

### How it learns

Learning is in-context, not fine-tuning. A lesson is a one-sentence rule backed by evidence, stored
per workspace and appended to the system prompt of the agent it is scoped to:

| Signal in a cycle | Lesson | Injected into |
|---|---|---|
| A heal removed a fixed `waitForTimeout` | `no-fixed-waits` | `spec-author` |
| A heal swapped a styling-class selector | `stable-selectors` | `spec-author` |
| The verifier found an uncovered criterion | `behaviour-per-criterion` | `story-analyzer` |
| A test failed on the application | `known-defect-<story>` | `qe-auto-heal` |

Lessons correct themselves. Seen again → **reinforced**. Applied and the problem stayed away →
**confirmed**. Applied and the problem came back anyway → **contradicted**, confidence drops, and
below 0.25 the lesson **retires**. Anything in memory can be forgotten from the UI.

Learning never touches an assertion. A test that caught a real defect stays red, the defect is
reported every cycle until the application is fixed, and the requirements verdict stays `reject`.

### Execution is simulated — for now

Gantry does not yet drive a browser against your application, so `src/lib/agents/executor.ts`
simulates one, and the run log says so. It is not random: it reads the spec source and fails a test
for the reasons a real run would (a fixed sleep racing the render, a styling selector that matches
nothing, a criterion the simulated app violates), so a heal genuinely turns a test green. Replace
`executeSpec` with a call to your runner and nothing else changes.

With no `ANTHROPIC_API_KEY` the simulated agents pause briefly between steps so the cycle can be
watched; `AUTOPILOT_PACE_MS` overrides the pause (`0` for none).

---

## Run it locally

```bash
git clone https://github.com/chandan180892/agentic-automation.git
cd agentic-automation
npm install
cp .env.example .env          # then fill it in — see below
npm run db:up                 # Postgres 16 in Docker (docker-compose.yml)
npm run db:deploy             # applies the migrations
npm run dev                   # http://localhost:3000 — the job worker starts with it
```

Any Postgres 14+ works; point `DATABASE_URL` at it instead of running `db:up`.

### Minimum `.env` to sign in

```bash
DATABASE_URL="postgresql://gantry:gantry@localhost:5432/gantry"
AUTH_SECRET="…"               # openssl rand -base64 32
AUTH_URL="http://localhost:3000"
AUTH_TRUST_HOST="true"
```

Then add **at least one** OAuth provider — the login page renders only the buttons you configure,
and tells you plainly when none are set.

**Google** — [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
→ Create OAuth client ID → Web application. Authorised redirect URI:
`http://localhost:3000/api/auth/callback/google`

```bash
AUTH_GOOGLE_ID="…"
AUTH_GOOGLE_SECRET="…"
```

**GitHub** — [github.com/settings/developers](https://github.com/settings/developers) → New OAuth
App. Authorization callback URL: `http://localhost:3000/api/auth/callback/github`

```bash
AUTH_GITHUB_ID="…"
AUTH_GITHUB_SECRET="…"
```

### To take the agents live

```bash
ANTHROPIC_API_KEY="sk-ant-…"
ANTHROPIC_MODEL="claude-sonnet-5"
```

Sessions are database-backed httpOnly cookies. Gantry stores no passwords and never asks for one.

---

## Connect Jira, Xray and Bitbucket

Credentials go in the environment; the per-workspace coordinates (project keys, repo) go in
**Settings** in the app.

```bash
# Jira Cloud — id.atlassian.com/manage-profile/security/api-tokens
JIRA_BASE_URL="https://your-site.atlassian.net"
JIRA_EMAIL="you@example.com"
JIRA_API_TOKEN="..."

# Xray Cloud — Jira → Apps → Xray → API Keys
XRAY_CLIENT_ID="..."
XRAY_CLIENT_SECRET="..."

# Bitbucket Cloud — Personal settings → App passwords
# Scopes: repository:read, repository:write, pullrequest:write
BITBUCKET_USERNAME="..."
BITBUCKET_APP_PASSWORD="..."
```

Acceptance criteria have no standard Jira field, so the importer checks the common custom fields
first and falls back to parsing an "Acceptance Criteria" section out of the description — rather
than reporting that a story has none.

## Deploy the app

The app is FE + BE in one Next.js deployable.

### Render — one click, database included (fastest)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Chandan180892/Agentic-Automation)

`render.yaml` provisions the web service **and** a Postgres database together, generates
`AUTH_SECRET`, and applies the migrations on start. Or do it by hand:
Render → **New → Blueprint** → point at this repo → Apply.

It boots with `ALLOW_DEMO_LOGIN=true`, so you can sign in and use the whole app before creating a
single OAuth client. Two things to do once it is up:

1. Set `AUTH_URL` to the URL Render gave you, so OAuth callbacks and secure cookies resolve.
2. Add `ANTHROPIC_API_KEY` to take the agents off the simulator.

Then add Google or GitHub credentials and set `ALLOW_DEMO_LOGIN=false`.

### Container (runs anywhere)

`.github/workflows/docker.yml` builds and pushes `ghcr.io/<owner>/<repo>` on every push to `main`.
Point Fly.io, Render, Railway, Cloud Run, or a plain VM at that image. Or build it yourself:

```bash
docker build -t gantry .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://…" \
  -e AUTH_SECRET="…" -e AUTH_URL="https://your-domain" -e AUTH_TRUST_HOST=true \
  -e AUTH_GITHUB_ID="…" -e AUTH_GITHUB_SECRET="…" \
  -e ANTHROPIC_API_KEY="…" \
  gantry
```

On start the container applies pending migrations (`prisma migrate deploy` — reviewed migration
files only, never a destructive schema rewrite), so a fresh database needs no extra step.

### Vercel

```bash
npx vercel --prod
```

Set the same environment variables in the project settings, with a hosted Postgres. Serverless
functions cannot keep a job worker alive, so set `WORKER_MODE=off` there and run the worker
somewhere long-lived — the container image with `WORKER_MODE=inline` and no traffic, or
`npm run worker` on any machine that can reach the database. Runs stay `queued` until a worker
picks them up, and `/api/ready` reports when none has checked in.

### Production

[docs/OPERATIONS.md](docs/OPERATIONS.md) covers configuration, scaling workers, monitoring
(`/api/health`, `/api/ready`, structured logs), the runbook, and database changes.
[SECURITY.md](SECURITY.md) covers roles, approvals, audit, rate limits and spend caps.

### GitHub Pages — the in-browser app

https://chandan180892.github.io/Agentic-Automation/ serves `docs/` from the default branch
(Settings → Pages → *Deploy from a branch*, folder `/docs`).

- `docs/index.html` is Gantry running **in the browser**: Autopilot, Backlog, Agents, Runs. The
  agents are simulated on the same logic as the server app's simulator mode — nothing is sent
  anywhere and no key is needed — so anyone can watch the loop plan, test, heal, review and learn.
- `docs/prototype.html` is the original screen prototype.

Pages serves static files only, so live Claude agents, Jira/Xray/Bitbucket and Postgres need the
server app deployed as above.

## Tests

```bash
npm run test:agents     # top-level agent contracts
npm run test:pipeline   # all six sub-agents, including the revision loop
npm run test:e2e        # the orchestrator against a real database
npm run test:autopilot  # learning cycles: heals, review, lessons, approval, bugs, run-until-stable
npm run test:platform   # job queue, worker, crash recovery, retention, env validation
npm run test:auth       # session handling across every authenticated page
npm test                # all of the above except auth
npm run typecheck
```

The suites need a Postgres database (`DATABASE_URL`). `test:auth` needs the app running
(`npm start` on port 3210, or set `BASE`).

The suites assert the behaviours that make the pipeline trustworthy, not just that it runs:
`story-analyzer` refuses to call an unspecified story testable, `clarify` blocks rather than
guessing, `asset-resolver` never recreates what it reuses, `verifier` reports uncovered criteria
honestly, `reviewer` refuses to publish uncovered work, a revision closes the gap the verifier
found, and an end-to-end run proposes publications **without publishing any of them**. The autopilot
suite runs two cycles on one sprint and asserts that the second one needs fewer heals and revisions,
that no heal ever patches an application defect, and that a lesson which does not help is
contradicted and retired. CI runs all of it on every push.

---

## How a story becomes a test suite

```
Jira story
   └─ story-analyzer → clarify → asset-resolver → spec-author → verifier → reviewer
                          │                            ↑           │
                     blocks & asks                     └───────────┘
                                                     revises, up to 2×
   └─ proposals → you approve → Xray test cases + Bitbucket branch & PR
```

1. **Import.** Stories come from Jira, with acceptance criteria and story points.
2. **Plan.** `sprint-planner` sizes what has no estimate and commits to capacity.
3. **Pipeline.** Each committed story walks the six sub-agents above.
4. **Approve.** The reviewer's approval produces proposals; yours publishes them.

## Repository layout

```
src/app/(app)/              authenticated screens — sprint, autopilot, agents, runs, results, settings
src/app/api/                live-state polling, /api/health, /api/ready
src/lib/agents/             agent registry and runtime; llm.ts is the one model client
src/lib/agents/pipeline*.ts the six sub-agents and the orchestrator that runs them
src/lib/agents/autopilot.ts the self-learning cycle; memory.ts, executor.ts beside it
src/lib/jobs/               the durable job queue, its handlers and the worker
src/lib/env.ts, log.ts      validated configuration, structured logging
src/lib/guard.ts            roles, audit log, rate limits, user-facing action errors
src/lib/atlassian/          Jira, Xray and Bitbucket Cloud clients
src/instrumentation.ts      boot: environment checks and the inline worker
prisma/schema.prisma        the data model; prisma/migrations holds every change to it
docs/OPERATIONS.md          deploying, scaling, monitoring, runbook
docs/index.html             the design prototype (served by GitHub Pages)
scripts/                    test suites and the standalone worker
```
