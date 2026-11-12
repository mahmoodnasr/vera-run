// vera-run GitHub Action — zero-dependency node24 script.
// Triggers a Vera run over /api/v1 and gates the job on BLOCKING failures
// only: quarantined-test failures and passed-on-retry flakes surface as
// warnings (annotations + job summary), never disappear, and never fail the
// job unless fail-on-flaky is set.
import { appendFileSync } from 'node:fs';

const input = (name) =>
  (process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim();
const setOutput = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
const summary = (markdown) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
};
const warn = (msg) => console.log(`::warning::${msg}`);
const fail = (msg) => {
  console.log(`::error::${msg}`);
  process.exitCode = 1;
};

// Preview URL: explicit input, else common provider variables. VERCEL_URL is
// host-only (no scheme); Netlify's DEPLOY_PRIME_URL/DEPLOY_URL are full URLs.
function resolvePreviewUrl() {
  const explicit = input('preview-url');
  if (explicit) return explicit;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || '';
}

async function main() {
  const apiUrl = input('api-url').replace(/\/+$/, '');
  const token = input('api-token');
  const project = input('project');
  if (!apiUrl || !token || !project) {
    fail('vera-run: api-url, api-token, and project are required inputs.');
    return;
  }

  const body = {};
  if (input('test')) body.testId = input('test');
  else if (input('suite')) body.suiteId = input('suite');
  else body.all = true;
  if (input('environment')) body.environment = input('environment');
  const previewUrl = resolvePreviewUrl();
  if (previewUrl) body.baseUrlOverride = previewUrl;

  console.log(
    `Running Vera project ${project}` +
      (body.testId
        ? ` test ${body.testId}`
        : body.suiteId
          ? ` suite ${body.suiteId}`
          : ' (all tests)') +
      (body.environment ? ` on environment "${body.environment}"` : '') +
      (previewUrl ? ` against ${previewUrl}` : ''),
  );

  let res;
  try {
    // The run executes synchronously server-side; the response carries the
    // terminal result (typically a few minutes for a suite).
    res = await fetch(`${apiUrl}/api/v1/projects/${encodeURIComponent(project)}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(`vera-run: could not reach ${apiUrl} — ${err?.message ?? err}`);
    return;
  }

  if (res.status === 401) {
    // Revoked/invalid token: fail securely without echoing anything sensitive.
    fail('vera-run: the Vera API token was rejected (invalid or revoked).');
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    fail(`vera-run: run failed to start (HTTP ${res.status}) ${text}`);
    return;
  }

  const r = await res.json();
  const isSingle = Boolean(body.testId);
  const passed = isSingle ? (r.status === 'passed' ? 1 : 0) : (r.passed ?? 0);
  const failed = isSingle ? (r.status === 'failed' ? 1 : 0) : (r.failed ?? 0);
  const quarantinedFailed = isSingle
    ? r.status === 'failed' && r.quarantined
      ? 1
      : 0
    : (r.quarantinedFailed ?? 0);
  const passedOnRetry = isSingle ? (r.passedOnRetry ? 1 : 0) : (r.passedOnRetry ?? 0);
  // A third kind of green: the run passed, but only after self-heal rewrote a
  // selector. Never blocking on its own — healing preserves the assertion — but
  // opt-in gating via fail-on-healed, mirroring fail-on-flaky exactly.
  //
  // ALWAYS 0 IN PRACTICE TODAY, deliberately. /api/v1 executes a CI-started run
  // cloud-side (server or worker, whatever the runTarget) and neither attaches
  // a selector healer — only vera-agent runs with the org's
  // settings.agent.selfHeal on, and the repair and AI-generation surfaces, can
  // heal, and this action starts none of them — so the server reports
  // `healed: false`/0 and the fail-on-healed branch below cannot be reached.
  // The branch is kept and covered by ci-gating-parity.test.ts so the opt-in is
  // already correct the day a CI-started run can heal. fail-on-flaky is not
  // affected: retries happen on every run.
  const healed = isSingle ? (r.healed ? 1 : 0) : (r.healed ?? 0);
  // B3.9 — critical tests this job did NOT run. A single-test invocation makes
  // no claim about project-wide coverage (you asked for one test and got one),
  // so it is 0 there; gating `--test` on other tests not running would make it
  // unusable in CI.
  //
  // Zero until a project has APPROVED risk assessments, so it gates nothing on
  // an unscored project — a gate that fired on unassessed work would make the
  // risk model something people disable instead of fill in.
  const unrunCritical = isSingle ? 0 : (r.unrunCritical ?? 0);
  if (
    isSingle
      ? typeof r.blocking !== 'boolean'
      : !Number.isSafeInteger(r.blockingFailed) || r.blockingFailed < 0
  ) {
    throw new Error('Vera returned an invalid gate response: missing or invalid blocking verdict.');
  }
  const blocking = isSingle ? r.blocking : r.blockingFailed > 0;
  const status = blocking ? 'failed' : 'passed';

  // S3.97 — a run can be NEITHER passed nor failed. `passed` and `failed` above
  // are both derived from `status`, so a run somebody stopped came out as
  // "0 passed, 0 failed" and then, from the gate, as "the test failed". The
  // exit code was right both times — `blocking` decides that, and a
  // cancellation blocks — but every sentence around it described a run that
  // was neither. Nothing below changes an exit code; the status simply reaches
  // the sentences, on the same rule the JUnit export follows for the same run.
  //
  // Single-test runs only: a batch payload folds a cancelled member into
  // `failed` and carries no count to separate out, and guessing one here would
  // be the same class of defect this fixes.
  const incomplete = isSingle && r.status !== 'passed' && r.status !== 'failed' ? 1 : 0;
  const incompleteWhy =
    r.status === 'cancelled'
      ? 'the run was cancelled'
      : `the run did not complete (status: ${r.status || 'unknown'})`;

  setOutput('status', status);
  setOutput('report-url', r.reportUrl ?? '');
  setOutput('passed', String(passed));
  setOutput('failed', String(failed));
  setOutput('quarantined-failed', String(quarantinedFailed));
  setOutput('passed-on-retry', String(passedOnRetry));
  setOutput('healed', String(healed));
  setOutput('unrun-critical', String(unrunCritical));
  // The shell gate's VERA_INCOMPLETE, in this surface's idiom. `status` stays
  // two-valued (passed|failed) — it is the GATE's answer, and widening its
  // domain would break every workflow that branches on it. This is the run's
  // own fact, reported beside it.
  setOutput('incomplete', String(incomplete));

  console.log(
    incomplete
      ? `Vera result: ${passed} passed, ${failed} failed — ${incompleteWhy}, so no verdict was reached.`
      : `Vera result: ${passed} passed, ${failed} failed.`,
  );
  if (r.reportUrl) console.log(`Report: ${r.reportUrl}`);

  // Flake/quarantine visibility: always annotate, never hide.
  if (quarantinedFailed > 0) {
    warn(
      `Vera: ${quarantinedFailed} quarantined test${quarantinedFailed === 1 ? '' : 's'} failed — ` +
        'reported but not gating this job. Review the Needs Attention queue.',
    );
  }
  if (passedOnRetry > 0) {
    warn(
      `Vera: ${passedOnRetry} test${passedOnRetry === 1 ? '' : 's'} passed only on retry (flaky).`,
    );
  }
  if (healed > 0) {
    warn(
      `Vera: ${healed} test${healed === 1 ? '' : 's'} passed only after a selector was healed — ` +
        'the assertion held, but check the step drove the control you meant.',
    );
  }

  if (unrunCritical > 0) {
    warn(
      `Vera: ${unrunCritical} critical test${unrunCritical === 1 ? '' : 's'} did NOT run in this ` +
        'job. A green gate here covers only what ran.',
    );
  }

  summary(
    `## Vera E2E — ${status === 'passed' ? '✅ passed' : '❌ failed'}\n\n` +
      `| Passed | Failed | Quarantined failures | Passed on retry | Passed on heal |\n|---|---|---|---|---|\n` +
      `| ${passed} | ${failed} | ${quarantinedFailed} | ${passedOnRetry} | ${healed} |\n\n` +
      // S3.97 — the table is five counts, and a run that reached no verdict is
      // in none of them, so it would read as an all-zero row. It is stated in
      // prose beneath rather than as a sixth column: a column would be 0 on
      // every run anyone ever sees, and the panel is the surface a person looks
      // at precisely when the numbers do not explain the outcome. The heading
      // above is left alone deliberately — it renders the GATE's verdict, and a
      // quarantined cancellation is a green build with an incomplete run in it.
      (incomplete ? `> ⚠️ ${incompleteWhy} — no verdict was reached.\n\n` : '') +
      (previewUrl ? `Target: \`${previewUrl}\`\n\n` : '') +
      (r.reportUrl ? `[Open the report](${r.reportUrl})\n` : ''),
  );

  if (blocking) {
    // Same exit code, true sentence (S3.97). A run that reached no verdict is
    // red for a different reason than a failing one, and the exit code cannot
    // carry the difference — so the annotation does. "the test failed" about a
    // run nobody ever got an answer from sends a reader looking for a broken
    // assertion that does not exist.
    fail(
      incomplete
        ? `Vera: ${incompleteWhy} — no verdict was reached, so the build is gated. ${r.reportUrl ?? ''}`
        : `Vera: ${isSingle ? 'the test' : `${r.blockingFailed ?? failed} test(s)`} failed. ${r.reportUrl ?? ''}`,
    );
  } else if (input('fail-on-flaky') === 'true' && passedOnRetry > 0) {
    fail('Vera: flaky tests passed only on retry and fail-on-flaky is enabled.');
  } else if (input('fail-on-healed') === 'true' && healed > 0) {
    fail(
      `Vera: test(s) passed only after a healed selector and fail-on-healed is enabled. ${r.reportUrl ?? ''}`,
    );
  } else if (input('fail-on-unrun-critical') === 'true' && unrunCritical > 0) {
    fail(
      `Vera: ${unrunCritical} critical test(s) did not run and fail-on-unrun-critical is enabled. ${r.reportUrl ?? ''}`,
    );
  }
}

main().catch((err) => fail(`vera-run: unexpected error — ${err?.stack ?? err}`));
