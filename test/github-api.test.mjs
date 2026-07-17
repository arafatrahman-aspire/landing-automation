import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrPayload, isAlreadyExistsError } from "../src/github/api.mjs";

test("buildPrPayload shapes the request body", () => {
  const payload = buildPrPayload({ title: "t", head: "codegen/x", base: "main", body: "b" });
  assert.deepEqual(payload, { title: "t", head: "codegen/x", base: "main", body: "b" });
});

test("isAlreadyExistsError recognizes GitHub's 422 message", () => {
  assert.equal(
    isAlreadyExistsError({ message: "Validation Failed", errors: [{ message: "A pull request already exists for owner:branch." }] }),
    true
  );
  assert.equal(isAlreadyExistsError({ message: "Not Found" }), false);
});
