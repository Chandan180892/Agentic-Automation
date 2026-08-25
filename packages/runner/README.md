# @gantry/runner

Runs [Gantry](https://github.com/chandan180892/agentic-automation) QE jobs on your own machine.

```bash
npx @gantry/runner connect \
  --url https://your-gantry-url \
  --token gnt_rnr_… \
  --name my-laptop --slots 2 \
  --workdir ./e2e --exec "npx playwright test"
```

Connects **outbound only** — no inbound port, no VPN, no SSH key held by the server — so the same
command works on a cloud CI worker and on a laptop behind NAT.

For each claimed job it fetches the generated files from Gantry (the model key stays on the
server), writes them under `--workdir`, runs `--exec`, streams output back live, and reports the
outcome. Omit `--exec` to write files without executing them; add `--once` to take one job and
exit.

`--help` lists every flag. All of them also read from environment variables: `GANTRY_URL`,
`GANTRY_TOKEN`, `GANTRY_RUNNER_NAME`, `GANTRY_SLOTS`, `GANTRY_WORKDIR`, `GANTRY_EXEC`.
