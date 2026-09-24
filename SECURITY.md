# Security

## Reporting a vulnerability

Please report security issues privately to the repository owner rather than in a public issue.
Include the version (commit), what you found and how to reproduce it.

## How Gantry protects a workspace

**Sign-in.** OAuth (Google, GitHub) through Auth.js with database sessions in httpOnly cookies.
Gantry stores no passwords. Demo sign-in is off unless `ALLOW_DEMO_LOGIN=true`, and the server
warns at every production boot while it is on.

**Tenancy.** Every query is scoped to the signed-in user's workspace; ids from the browser are
looked up with the workspace id, so another workspace's data returns "not found".

**Roles.** Members can plan sprints and run agents. Writing to Jira, Xray or Bitbucket, changing
integrations, and approving, rejecting or deleting lessons need the owner or admin role.

**Nothing is written without approval.** Agents produce proposals; only an explicit approval by
an owner or admin publishes one, the claim is atomic (no double writes), and every approval,
settings change, lesson decision and agent start is recorded in the audit log with the actor.

**Agents cannot weaken tests.** Heals may change selectors and waits; a failure on an assertion
is classified as an application defect and escalated, never patched. Learned lessons never
lower coverage or change assertions, and in review mode a person approves each one first.

**Abuse and cost.** Agent-starting actions are rate-limited per workspace; model spend is capped
per workspace per day; model calls have timeouts and bounded retries.

**Transport and browser.** Production responses carry a Content-Security-Policy (same-origin
only, no framing), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and a strict
referrer policy. Inputs to server actions are validated against schemas.

**Secrets.** Credentials (Anthropic, Atlassian, OAuth) live only in environment variables and are
never written to the database or logs. The configuration is validated at boot; a weak
`AUTH_SECRET` stops a production server from starting.

**Known limits.** `script-src` allows `'unsafe-inline'` because Next.js hydrates with inline
scripts; a per-request nonce would remove it. The daily token budget is checked before each call,
so concurrent calls can overshoot it by a few requests.
