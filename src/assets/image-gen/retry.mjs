function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableHttpStatus(status) {
  const code = Number(status);
  return code === 429 || (code >= 500 && code < 600);
}

export function retryOnNetworkOrHttp(err, result) {
  return Boolean(err) || (result != null && isRetryableHttpStatus(result.status));
}

/**
 * Retry an async function on thrown errors or retryable HTTP Response statuses.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, retryDelayMs?: number, retryOn?: (err: Error, result?: T) => boolean }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { retries = 3, retryDelayMs = 800, retryOn } = {}) {
  let lastError;
  const attempts = Math.max(1, retries);
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      const looksLikeResponse = result && typeof result === "object" && "ok" in result && "status" in result;
      const shouldRetry =
        looksLikeResponse && !result.ok && (retryOn ? retryOn(null, result) : isRetryableHttpStatus(result.status));
      if (shouldRetry && i < attempts - 1) {
        await sleep(retryDelayMs * (i + 1));
        continue;
      }
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const retryable = retryOn ? retryOn(lastError) : true;
      if (!retryable || i >= attempts - 1) throw lastError;
      await sleep(retryDelayMs * (i + 1));
    }
  }
  throw lastError ?? new Error("retry exhausted");
}

/**
 * Poll `fn` until `isDone` returns truthy or `timeoutMs` elapses.
 *
 * @template T
 * @param {object} p
 * @param {() => Promise<T>} p.fn
 * @param {(result: T) => boolean} p.isDone
 * @param {(result: T) => boolean} [p.isFailed]
 * @param {(result: T) => string} [p.failMessage]
 * @param {number} [p.timeoutMs]
 * @param {number} [p.intervalMs]
 * @returns {Promise<T>}
 */
export async function pollUntil({
  fn,
  isDone,
  isFailed,
  failMessage,
  timeoutMs = 120_000,
  intervalMs = 2_000,
}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (isFailed?.(last)) {
      throw new Error(failMessage?.(last) || "generation failed");
    }
    if (isDone(last)) return last;
    await sleep(intervalMs);
  }
  const err = new Error("image generation poll timed out");
  err.name = "TimeoutError";
  throw err;
}
