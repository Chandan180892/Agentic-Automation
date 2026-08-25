# Gantry

**Sprint in. Green out.**

Gantry reads your sprint, writes the specs and test assets, runs them on machines you own —
cloud or the laptop under your desk — and proposes a patch when a spec breaks. Six agents drive
it end to end; you sign in, plan, and review.

- **Design prototype:** `docs/index.html` — published at https://chandan180892.github.io/Agentic-Automation/
- **Stack:** Next.js 16 (App Router, FE + BE in one deployable), Auth.js v5, Prisma, Anthropic SDK
- **Runner:** `packages/runner` — an outbound Node CLI, no inbound ports

---

## The agents

| Agent | Role | In → out |
|---|---|---|
| `sprint-planner` | Planning | backlog → sprint plan |
| `qe-pipelines` | Generation, one story | story → spec + assets |
| `qe-batch` | Generation, parallel | sprint plan → *n* jobs |
| `qe-auto-heal` | Repair, one spec | failure → verified patch |
| `batch-heal` | Repair, fleet | *n* failures → one PR |
| `qe-insights` | Analysis | run history → signals |

Every agent has a typed input, a typed output, and a system prompt built on three house rules:

1. **Never invent a requirement.** Missing acceptance criteria get drafted *and flagged*, never
   guessed at silently.
2. **Never weaken a test to make it pass.** Skipping, quarantining, or loosening an assertion is
   not a fix. If the application is wrong, the agent says the application is wrong.
3. **Be specific.** Name the file, the selector, the criterion, the commit.

Outputs are produced through a forced tool call, so a result either matches the agent's schema or
is rejected before it reaches your database. `scripts/agents-check.ts` asserts all of this,
including that `qe-auto-heal` patches a renamed selector but **refuses** to rewrite a correct
assertion.

### Simulator mode

With no `ANTHROPIC_API_KEY` set, each agent falls back to a deterministic built-in simulator and
every result is labelled `simulated` all the way to the UI. Storage, jobs, runners, and review are
still real, so a fresh clone is fully explorable before anyone configures a key.

### Demo sign-in

OAuth is the real way in, but a brand-new deployment has no OAuth client yet — which would leave
the app behind a door nobody can open. Set `ALLOW_DEMO_LOGIN=true` and the login page offers a
shared demo workspace instead.

It is off unless you switch it on, and the page says plainly what it is: **everyone who signs in
this way lands in the same workspace and can see each other's work.** Turn it off once real
sign-in is configured.

---

## Run it locally

```bash
git clone https://github.com/chandan180892/agentic-automation.git
cd agentic-automation
npm install
cp .env.example .env          # then fill it in — see below
npm run db:push               # creates dev.db
npm run dev                   # http://localhost:3000
```

### Minimum `.env` to sign in

```bash
DATABASE_URL="file:./dev.db"
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

## Connect a runner

Gantry executes nothing on its own machines. Register a runner in **Runners**, copy the token
(shown once — only its hash is stored), and start it wherever you want the work to happen:

```bash
npx @gantry/runner connect \
  --url https://your-gantry-url \
  --token gnt_rnr_… \
  --name ci-worker-1 --slots 4 \
  --workdir ./e2e --exec "npx playwright test"
```

From this repo, without publishing: `npm run runner -- connect --url … --token …`

The runner dials **out** over HTTPS and polls for work. No inbound port, no VPN, no SSH key held
by the server — so the same command works on a cloud CI box and on a laptop behind NAT.

For each job it claims, the runner asks Gantry for the generated files (the model key stays on the
server), writes them under `--workdir`, runs `--exec`, streams the output back into the run view
live, and reports the outcome with whatever it produced. Omit `--exec` and it writes the files
without executing them. Add `--once` to take a single job and exit, which is what you want in CI.

Useful flags: `--slots` (concurrency), `--poll-ms`, `--workdir`, `--once`, `--help`.

---

## Deploy the app

The app is FE + BE in one Next.js deployable.

### Render — one click, database included (fastest)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Chandan180892/Agentic-Automation)

`render.yaml` provisions the web service **and** a Postgres database together, generates
`AUTH_SECRET`, and switches Prisma to the Postgres provider during the build. Or do it by hand:
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

The container applies the schema on boot, so a fresh database needs no extra step.

### Vercel

```bash
npx vercel --prod
```

Set the same environment variables in the project settings. Use Postgres rather than SQLite —
serverless filesystems do not persist:

```bash
npm run db:postgres     # switches the Prisma provider
npm run db:push
```

### GitHub Pages

The prototype lives at `docs/index.html` and is published two ways, so either works:

- **Deploy from a branch** — Settings → Pages → Source: *Deploy from a branch*, branch:
  `claude/ai-agent-sprint-app-8a2yxn`, folder: `/docs`. No Actions runner involved.
- **GitHub Actions** — Settings → Pages → Source: *GitHub Actions*. Then
  `.github/workflows/deploy-pages.yml` republishes on every change to `docs/`.

Pages serves static files only, so it hosts the prototype, not the app.

**After deploying, update each OAuth app's callback URL** to
`https://your-domain/api/auth/callback/<provider>` and set `AUTH_URL` to match, or sign-in will
fail with a redirect mismatch.

---

## Tests

```bash
npm run test:agents    # every agent's contract, through the real runtime
npm run test:smoke     # runner protocol against a running server
npm run test:auth      # session handling across every authenticated page
npx tsc --noEmit       # typecheck
```

`test:smoke` and `test:auth` need the app running (`npm start` on port 3210, or set `BASE`).
Between them they cover runner token rejection, single-claim-under-race, log streaming, run
auto-close, cross-workspace isolation, and — on the auth side — that every authenticated page
requires a session and that expired and forged session tokens are refused. CI runs all of it on
every push.

---

## How a story becomes green

```
sprint-planner → qe-batch → qe-pipelines → your runner → qe-auto-heal → batch-heal
   backlog         n jobs      spec+assets     execution      patch          one PR
```

1. **Plan.** `sprint-planner` sizes what has no estimate, orders by dependency, commits to
   capacity, and drafts acceptance criteria where they are missing — flagged for review.
2. **Generate.** `qe-batch` shards the committed stories across your available runner slots and
   queues one job each. A single story goes through `qe-pipelines` directly instead.
3. **Execute.** Your runners claim jobs, write the files, run the suite, and stream logs back.
4. **Heal.** A failure goes to `qe-auto-heal`, which patches selector, timing, and data drift —
   and refuses assertion rewrites. When one change breaks many specs, `batch-heal` groups them by
   root cause and opens a single PR with only the ones that went green.

---

## Repository layout

```
src/app/(app)/          authenticated screens — sprint, agents, runs, runners, results, settings
src/app/api/runner/     the outbound runner protocol: heartbeat, claim, generate, log, complete
src/lib/agents/         registry (prompts + simulators), schemas, runtime
packages/runner/        the runner CLI
prisma/schema.prisma    workspaces, sprints, stories, runs, jobs, assets, events, runners
docs/index.html         the design prototype this app was built from (served by Pages)
scripts/                agent contract checks and the runner protocol smoke test
```
