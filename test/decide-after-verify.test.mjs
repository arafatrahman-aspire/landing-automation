import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAfterVerify } from "../src/pipeline/decide-after-verify.mjs";

const opts = { maxCodeAttempts: 3, continueOnVerifyFailure: false };
const bypass = { maxCodeAttempts: 3, continueOnVerifyFailure: true };

test("passing verify always stages", () => {
  assert.equal(decideAfterVerify({ verifyPassed: true, codeAttempts: 1 }, opts), "stage_draft");
});

test("our own failure still retries while budget remains", () => {
  assert.equal(
    decideAfterVerify({ verifyPassed: false, verifyForeignFailure: false, codeAttempts: 1 }, opts),
    "generate_sections"
  );
});

test("foreign-only failure skips retries — regenerating cannot help", () => {
  assert.equal(
    decideAfterVerify({ verifyPassed: false, verifyForeignFailure: true, codeAttempts: 1 }, opts),
    "end"
  );
  assert.equal(
    decideAfterVerify({ verifyPassed: false, verifyForeignFailure: true, codeAttempts: 1 }, bypass),
    "stage_draft",
    "CONTINUE_ON_VERIFY_FAILURE still stages, but without burning retries"
  );
});

test("exhausted retries honour CONTINUE_ON_VERIFY_FAILURE", () => {
  assert.equal(
    decideAfterVerify({ verifyPassed: false, verifyForeignFailure: false, codeAttempts: 3 }, opts),
    "end"
  );
  assert.equal(
    decideAfterVerify({ verifyPassed: false, verifyForeignFailure: false, codeAttempts: 3 }, bypass),
    "stage_draft"
  );
});
