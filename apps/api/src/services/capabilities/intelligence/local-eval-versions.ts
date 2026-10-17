/**
 * The versions a Distpatch Local Evaluation artifact must carry to be production-eligible.
 *
 * Single source of truth shared by the harness that writes artifacts (`bench/calibration`) and the
 * evidence source that reads them, so the two cannot drift: the writer stamps these values, the
 * reader accepts exactly these values. Changing what a number means (cases, grader, normalization)
 * bumps the matching constant; older artifacts then stay stored as historical evidence only.
 */
export const LOCAL_EVAL_SUITE_VERSION = "distpatch-calibration-v1"
/** The sandboxed (bubblewrap) grader. Earlier, unsandboxed graders are `...-pre-sandbox`. */
export const LOCAL_EVAL_GRADER_VERSION = "distpatch-grader-v1-bwrap"
export const LOCAL_EVAL_NORMALIZATION_VERSION = "distpatch-norm-v1"
