# Gantry

**Sprint in. Green out.**

Gantry reads your **Jira** stories, walks each one through a chain of six sub-agents, and proposes
**Xray** test cases and a **Bitbucket** branch and pull request. Nothing is written to your systems
until you approve it.

- **Design prototype:** `docs/index.html` — published at https://chandan180892.github.io/Agentic-Automation/
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
npm run test:agents     # top-level agent contracts
npm run test:pipeline   # all six sub-agents, including the revision loop
npm run test:e2e        # the orchestrator against a real database
npm run test:auth       # session handling across every authenticated page
npx tsc --noEmit        # typecheck
```

`test:auth` needs the app running (`npm start` on port 3210, or set `BASE`).

The suites assert the behaviours that make the pipeline trustworthy, not just that it runs:
`story-analyzer` refuses to call an unspecified story testable, `clarify` blocks rather than
guessing, `asset-resolver` never recreates what it reuses, `verifier` reports uncovered criteria
honestly, `reviewer` refuses to publish uncovered work, a revision closes the gap the verifier
found, and an end-to-end run proposes publications **without publishing any of them**. CI runs all
of it on every push.

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
src/app/(app)/              authenticated screens — sprint, agents, runs, results, settings
src/lib/agents/             top-level registry, runtime
src/lib/agents/pipeline*.ts the six sub-agents and the orchestrator that runs them
src/lib/atlassian/          Jira, Xray and Bitbucket Cloud clients
prisma/schema.prisma        workspaces, sprints, stories, runs, stages, test cases, publications
docs/index.html             the design prototype (served by GitHub Pages)
scripts/                    agent, sub-agent, orchestrator and auth suites
```
