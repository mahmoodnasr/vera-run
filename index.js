// vera-run GitHub Action — zero-dependency node24 script.
// Triggers a Vera run over /api/v1 and gates the job on BLOCKING failures
// only: quarantined-test failures and passed-on-retry flakes surface as
// warnings (annotations + job summary), never disappear, and never fail the
// job unless fail-on-flaky is set.
import { randomUUID } from 'node:crypto';
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

  const r = await startAndAwaitRun(apiUrl, token, project, body);
  if (!r) return;
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
  // Critical tests this job did NOT run. A single-test invocation makes
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

  // A run can be NEITHER passed nor failed. `passed` and `failed` above
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
      // The table is five counts, and a run that reached no verdict is
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
    // Same exit code, true sentence. A run that reached no verdict is
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

// ---------------------------------------------------------------------------
// Transport: start, poll, answer.
//
// The run is started with `wait: false`, so the server answers as soon as the
// runs are dispatched; each run is then long-polled at /runs/:id/wait (the
// server holds each poll for up to a minute); and once every run is terminal
// the same request is sent again, with the same Idempotency-Key and
// `wait: true`, which returns the verdict for exactly those runs. No call
// holds a connection for much more than a minute, so neither a proxy, Node's
// own 300 s headers timeout nor a server deploy can cut a long run off — and
// because every call carries the key, retrying any of them never starts a
// second set of runs.
//
// The verdict is the SERVER's. This file never decides `blocking` itself; it
// reads it off the final answer exactly as it did when that answer came back
// from one long request. A server that answers the first request with the
// verdict straight away (201) — one that runs tests in its own process, or
// one that predates `wait` — is read the same way.
// ---------------------------------------------------------------------------

/** How long the whole start-poll-answer exchange may take. */
const RUN_DEADLINE_MS = 60 * 60_000;
/** Attempts per call, whatever the server's Retry-After says. */
const MAX_ATTEMPTS = 240;
/** Attempts per call that got no answer or a 5xx. */
const MAX_FAULT_ATTEMPTS = 8;
const TERMINAL = new Set(['passed', 'failed', 'cancelled']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A refusal that clears by itself as runs finish: the workspace is at its
 * concurrent-run limit, or its queue is full. Any other plan_limit (a feature
 * the plan lacks, a project cap) is a plan fact, and retrying cannot fix it.
 */
function isRunSlotRefusal(status, json) {
  return (
    status === 403 &&
    json?.code === 'plan_limit' &&
    (json.limitKey === 'maxConcurrentRuns' || json.limitKey === 'queuedRuns')
  );
}

/** Retry-After when the server sent one, else capped exponential backoff. */
function retryDelayMs(res, attempt) {
  const header = res?.headers?.get('retry-after')?.trim();
  if (header && /^\d+$/.test(header)) return Math.min(Number(header), 60) * 1000;
  return Math.min(60_000, 2_000 * 2 ** attempt);
}

/** A connection that dropped or stalled: worth another attempt. */
const DROPPED = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
/** Nothing listening at the address, or no such host: a wrong URL — unless the
 *  server just accepted the run, in which case it is restarting. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);

/** Is a call that got no response worth repeating? Anything unrecognised is not. */
function retryableNoAnswer(error, afterStart) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  const code = error?.cause?.code;
  return DROPPED.has(code) || (afterStart === true && UNREACHABLE.has(code));
}

/**
 * One call, retried while the answer is one that clears with time: no answer
 * at all (a timeout, a reset during a deploy), 5xx, 429, a concurrent request
 * with the same key still starting, or the run-slot refusal above. Faults (no
 * answer, 5xx) get MAX_FAULT_ATTEMPTS — long enough to ride out a deploy, short
 * enough that a broken server fails the job in minutes, not an hour. A
 * connection nobody accepts is retried only once the run exists (`afterStart`):
 * before that it means the URL is wrong (see `retryableNoAnswer`). Returns the
 * last response; throws only when no response ever arrived.
 */
async function callWithRetries(url, init, { deadline, requestTimeoutMs, what, afterStart }) {
  let faults = 0;
  for (let attempt = 0; ; attempt++) {
    let res;
    let json = null;
    let text = '';
    let error;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
      text = await res.text();
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
    } catch (err) {
      error = err;
    }
    const fault = error !== undefined || res.status >= 500;
    const later =
      !fault &&
      (res.status === 429 ||
        (res.status === 409 && json?.code === 'idempotency_in_progress') ||
        isRunSlotRefusal(res.status, json));
    if (!fault && !later) return { res, json, text };
    if (error !== undefined && !retryableNoAnswer(error, afterStart)) throw error;
    if (fault) faults++;
    const delay = retryDelayMs(res, attempt);
    if (
      faults >= MAX_FAULT_ATTEMPTS ||
      attempt + 1 >= MAX_ATTEMPTS ||
      Date.now() + delay > deadline
    ) {
      if (error !== undefined) throw error;
      return { res, json, text };
    }
    const seconds = Math.round(delay / 1000);
    if (error === undefined && isRunSlotRefusal(res.status, json)) {
      console.log(
        `Vera: the workspace is at its run limit (${json.error ?? json.limitKey}) — ` +
          `retrying ${what} in ${seconds}s.`,
      );
    } else {
      const why =
        error !== undefined ? `no answer (${error?.message ?? error})` : `HTTP ${res.status}`;
      console.log(`Vera: ${what} got ${why} — retrying in ${seconds}s (attempt ${attempt + 2}).`);
    }
    await sleep(delay);
  }
}

/**
 * Start the run and return the server's final answer, or null after reporting
 * why there is none. Every failure here fails the job closed.
 */
async function startAndAwaitRun(apiUrl, token, project, body) {
  const runUrl = `${apiUrl}/api/v1/projects/${encodeURIComponent(project)}/run`;
  const requestTimeoutMs = Math.max(1, Number(input('request-timeout-seconds')) || 120) * 1000;
  const deadline = Date.now() + RUN_DEADLINE_MS;
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    // One key per job attempt: every retry below is the SAME request, and a
    // re-run of the job is deliberately a new one.
    'idempotency-key': randomUUID(),
  };
  const opts = (what, afterStart) => ({ deadline, requestTimeoutMs, what, afterStart });
  const post = (wait, what) =>
    callWithRetries(
      runUrl,
      { method: 'POST', headers, body: JSON.stringify({ ...body, wait }) },
      opts(what, wait),
    );

  const refused = (res, text, doing) => {
    if (res.status === 401) {
      // Revoked/invalid token: fail securely without echoing anything sensitive.
      fail('vera-run: the Vera API token was rejected (invalid or revoked).');
    } else {
      fail(`vera-run: ${doing} (HTTP ${res.status}) ${text}`);
    }
    return null;
  };

  let started;
  try {
    started = await post(false, 'starting the run');
  } catch (err) {
    fail(`vera-run: could not reach ${apiUrl} — ${err?.message ?? err}`);
    return null;
  }
  if (!started.res.ok) return refused(started.res, started.text, 'run failed to start');
  if (started.res.status !== 202) {
    if (!started.json) throw new Error('Vera returned a response this action cannot read.');
    return started.json;
  }

  const runIds = Array.isArray(started.json?.runIds) ? started.json.runIds : [];
  const reportUrl = started.json?.reportUrl ?? '';
  console.log(`Vera started ${runIds.length} run(s); waiting for them to finish.`);
  let finished = 0;
  for (const runId of runIds) {
    for (;;) {
      if (Date.now() > deadline) {
        fail(
          `Vera: the runs did not finish within ${RUN_DEADLINE_MS / 60_000} minutes — no verdict ` +
            `was reached, so the build is gated. They may still be running: ${reportUrl}`,
        );
        return null;
      }
      let polled;
      try {
        polled = await callWithRetries(
          `${apiUrl}/api/v1/runs/${encodeURIComponent(runId)}/wait`,
          { headers: { authorization: headers.authorization } },
          opts(`waiting on run ${runId}`, true),
        );
      } catch (err) {
        fail(
          `vera-run: lost contact with ${apiUrl} while waiting — ${err?.message ?? err}. ` +
            `The runs may still be running: ${reportUrl}`,
        );
        return null;
      }
      if (polled.res.status === 202) continue;
      if (!polled.res.ok) return refused(polled.res, polled.text, `could not read run ${runId}`);
      if (TERMINAL.has(polled.json?.status)) break;
    }
    finished++;
    console.log(`Vera: ${finished}/${runIds.length} run(s) finished.`);
  }

  let answer;
  try {
    answer = await post(true, 'collecting the result');
  } catch (err) {
    fail(`vera-run: could not collect the result from ${apiUrl} — ${err?.message ?? err}`);
    return null;
  }
  if (!answer.res.ok || answer.res.status === 202) {
    return refused(answer.res, answer.text, 'could not collect the result');
  }
  if (!answer.json) throw new Error('Vera returned a response this action cannot read.');
  return answer.json;
}

main().catch((err) => fail(`vera-run: unexpected error — ${err?.stack ?? err}`));
