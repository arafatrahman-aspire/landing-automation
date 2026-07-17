/* Plain fetch against the GitHub REST API (no @octokit/rest — consistent with
 * the parent project's ai.mjs, which uses raw fetch instead of provider SDKs). */

/** Pure — unit-testable without network (test/github-api.test.mjs equivalent
 *  is folded into write-tool tests' spirit; kept separate here from the fetch). */
export function buildPrPayload({ title, head, base, body }) {
  return { title, head, base, body };
}

/** GitHub's 422 for "a PR already exists for this branch" — pure string check,
 *  no network, so it's trivially unit-testable. */
export function isAlreadyExistsError(responseBodyJson) {
  const msg = JSON.stringify(responseBodyJson ?? {}).toLowerCase();
  return msg.includes("already exists") || msg.includes("a pull request already exists");
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

export async function findExistingPr({ apiUrl, owner, repo, token, branchName, base }) {
  const url = `${apiUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${branchName}&base=${base}&state=open`;
  const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub list-PRs failed (${res.status}): ${await res.text()}`);
  const list = await res.json();
  return list[0] ?? null;
}

/**
 * Opens a PR; if GitHub reports one already exists for this branch (e.g. a
 * retried run after a crash between push and PR-open), returns the existing
 * one instead of erroring — idempotent by design (plan §6/§8).
 */
export async function createPullRequest({ apiUrl, owner, repo, token, title, head, base, body }) {
  const url = `${apiUrl}/repos/${owner}/${repo}/pulls`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(buildPrPayload({ title, head, base, body })),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.ok) return res.json();

  const errJson = await res.json().catch(() => ({}));
  if (res.status === 422 && isAlreadyExistsError(errJson)) {
    const existing = await findExistingPr({ apiUrl, owner, repo, token, branchName: head, base });
    if (existing) return existing;
  }
  throw new Error(`GitHub create-PR failed (${res.status}): ${JSON.stringify(errJson)}`);
}
