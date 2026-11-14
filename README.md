# vera-run

Run your [Vera](https://vera-agent.com) E2E tests from GitHub Actions and gate the PR
on **real** failures: quarantined-test failures and passed-on-retry flakes are
annotated as warnings — visible, never gating (unless you opt in).

Setup guide: <https://vera-agent.com/guide/ci-integration>.

> **Releasing:** the public `mahmoodnasr/vera-run` repository is a release copy
> of `actions/vera-run` in the Vera repository. Change it there, then copy the
> directory and move the `v1` tag.

## Usage

```yaml
name: E2E
on: [pull_request]

jobs:
  vera:
    runs-on: ubuntu-latest
    steps:
      # ... deploy your preview and capture its URL ...
      - uses: mahmoodnasr/vera-run@v1
        with:
          api-url: https://vera.example.com
          api-token: ${{ secrets.VERA_API_TOKEN }}
          project: proj_abc123
          # optional:
          # suite: suite_xyz          # or `test: test_xyz` for a single test
          # environment: staging      # named Vera environment profile
          # preview-url: ${{ steps.deploy.outputs.url }}
          # fail-on-flaky: 'true'
          # fail-on-healed: 'true'  # green only after a selector was healed
          #                         # (inert today — CI runs do not heal)
```

When `preview-url` is omitted the action falls back to `VERCEL_URL`,
`DEPLOY_PRIME_URL`, or `DEPLOY_URL` if the workflow exposes them. The preview
URL overrides the environment/project base URL — that's the PR workflow:
your AI-generated suite runs against every preview deploy.

## Inputs

| Input | Required | Description |
|---|---|---|
| `api-url` | ✓ | Base URL of your Vera deployment |
| `api-token` | ✓ | Vera CI token (`vera_…`), stored as a secret |
| `project` | ✓ | Project id to run |
| `test` | | Single test id (default: all tests) |
| `suite` | | Suite id (default: all tests) |
| `environment` | | Named environment profile |
| `preview-url` | | Deployment URL to test (overrides base URL) |
| `fail-on-flaky` | | `'true'` to fail when tests passed only on retry |
| `fail-on-healed` | | `'true'` to fail when a test passed only after self-heal rewrote a selector. **Inert today** — see [Green is not one thing](#green-is-not-one-thing) |
| `fail-on-unrun-critical` | | `'true'` to fail when a test whose inherited risk band is p0/p1 did not run in this invocation. Inert until the project has approved risk assessments |
| `request-timeout-seconds` | | How long any one HTTP call may take (default `120`) |

## Outputs

`status`, `report-url`, `passed`, `failed`, `quarantined-failed`,
`passed-on-retry`, `healed`, `unrun-critical`, `incomplete`. (`healed` is always
`0` today — see below.)

`unrun-critical` counts the tests whose inherited risk band is p0/p1 that this
job did not run (the count `fail-on-unrun-critical` gates on). It is `0` for a
single-test run, and `0` until the project has approved risk assessments.

`status` is the **gate's** verdict and stays two-valued (`passed` | `failed`).
`incomplete` is `1` when the run reached no verdict at all — someone stopped it,
or it was still running when the response was written. Such a run fails the job,
but not because a test failed, and the annotation says so rather than reporting
a failure nobody observed.

## Behavior

- The job **fails** on blocking failures (a failed, non-quarantined test) and on
  a run that reached **no verdict** — a cancellation is not a pass, and letting
  it through would turn stopping a run into a way to merge.
- A revoked or invalid token fails the job securely (no retry, nothing echoed).
- **No long-held connection.** The action starts the run with `wait: false`,
  long-polls each run at `/api/v1/runs/:id/wait`, then re-sends the request
  with the same `Idempotency-Key` and `wait: true` to collect the verdict for
  exactly those runs. A suite that runs for half an hour is therefore not cut
  off by Node's 300-second headers timeout, a proxy, or a Vera deploy.
- **Retries never start a second set of runs.** Every call carries one
  `Idempotency-Key`. A timeout, a reset or a 5xx is retried (8 attempts — long
  enough to ride out a deploy), and so are a 429 and a 403 `plan_limit` on
  `maxConcurrentRuns` / `queuedRuns` — the workspace is at its run limit, which
  clears as runs finish — each after the server's `Retry-After`, else a capped
  exponential backoff. Each retry is logged. Any other `plan_limit` fails at
  once. The whole exchange is bounded at 60 minutes.
- Quarantined failures, retry-flakes and healed passes produce `::warning::`
  annotations and a job-summary table with a link to the Vera report.

### Green is not one thing

A passing run can be green for three different reasons, and the action reports
which:

| Outcome | Gates the job? | Reachable from CI today? |
|---|---|---|
| Passed outright | no | yes |
| Passed only on a **retry** — flaky | no, unless `fail-on-flaky` | yes |
| Passed only after a **healed** selector | no, unless `fail-on-healed` | **no — see below** |

Self-heal rewrites the *locator* and never the *expectation*, so a healed pass
still had to satisfy its assertion — that is why it is not a failure. But the
step may now be driving a different control than the one it was written for
(the classic case: a `Delete` button disappears, the healer binds to a
neighbouring control, and a broad assertion still passes). `fail-on-healed`
turns that into a merge-blocking prompt for a human to look.

**`fail-on-healed` is inert today.** A run this action starts executes
cloud-side — on the Vera server or its worker, whatever the project's
`runTarget` — and neither attaches a selector healer, because healing
is an unbounded number of extra AI calls per run and a CI run that silently
rewrote its own selectors would make every green ambiguous. So `healed` comes
back `0` and the input cannot fail a job. It is kept, documented and exercised
by the gating-parity suite so that setting it now takes effect the day a
CI-started run can heal, rather than leaving you to discover the control is
missing at that moment.

Runs that **can** heal exist, but this action never starts one:

- `vera-agent` runs, when an org admin has turned on `settings.agent.selfHeal`
  (off by default). That includes `vera check --run --local` run inside a CI
  job — which has the same opt-in under the same names: `--fail-on-healed` or
  `VERA_FAIL_ON_HEALED=true` makes a healed pass exit 5.
- The repair surfaces (the Auto-heal button, auto-repair) and AI test
  generation, which self-heals unless the request turns it off.

Those runs report `healed: true` on `GET /api/v1/runs/:id`.

None of this touches `fail-on-flaky`: retries happen on every run, so
passed-on-retry is reported and gated today exactly as described above.
