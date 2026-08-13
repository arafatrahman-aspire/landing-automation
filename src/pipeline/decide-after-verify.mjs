/**
 * Pure routing decision after the verify step.
 *
 * @param {object} state
 * @param {boolean} [state.verifyPassed]
 * @param {boolean} [state.verifyForeignFailure] - build failed only in files
 *   this campaign did not create (target repo does not build on its own)
 * @param {number} state.codeAttempts
 * @param {object} opts
 * @param {number} opts.maxCodeAttempts
 * @param {boolean} opts.continueOnVerifyFailure
 * @returns {"stage_draft"|"generate_sections"|"end"}
 */
export function decideAfterVerify(state, { maxCodeAttempts, continueOnVerifyFailure }) {
  if (state.verifyPassed) return "stage_draft";

  // Pre-existing target-repo defect. Regenerating our sections cannot help —
  // burning the retry budget only delays the same failure three times.
  if (state.verifyForeignFailure) {
    return continueOnVerifyFailure ? "stage_draft" : "end";
  }

  if (state.codeAttempts < maxCodeAttempts) return "generate_sections";
  if (continueOnVerifyFailure) return "stage_draft";
  return "end";
}
