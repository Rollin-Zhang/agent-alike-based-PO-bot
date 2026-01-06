/**
 * validateToolStep.js
 * M2-B1-1: ToolStep 嚴格驗證器（只依賴 SSOT）
 *
 * Guardrails:
 * - 所有錯誤回穩定 code，不靠 throw 字串
 * - 在進 gateway 前就擋掉 unknown tool / invalid args
 */

const {
  RUN_CODES,
  CODE_TO_STATUS,
  validateToolStepShape,
  validateToolArgs,
  validateBudget,
  validateEvidenceCandidateShape
} = require('./ssot');

/**
 * 驗證完整 ToolStep（shape + tool exists + args + budget）
 * @param {Object} step - ToolStep object
 * @returns {{ valid: boolean, status?: string, code?: string, message?: string }}
 */
function validateToolStep(step) {
  // 1) 驗證 shape
  const shapeResult = validateToolStepShape(step);
  if (!shapeResult.valid) {
    return {
      valid: false,
      status: CODE_TO_STATUS[shapeResult.code],
      code: shapeResult.code,
      message: shapeResult.message
    };
  }

  const { tool_name, args, budget } = step;

  // 2) 驗證 tool_name + args（per-tool allowlist）
  const argsResult = validateToolArgs(tool_name, args);
  if (!argsResult.valid) {
    return {
      valid: false,
      status: CODE_TO_STATUS[argsResult.code],
      code: argsResult.code,
      message: argsResult.message
    };
  }

  // 3) 驗證 budget（只認 max_steps/max_wall_ms）
  const budgetResult = validateBudget(budget);
  if (!budgetResult.valid) {
    return {
      valid: false,
      status: CODE_TO_STATUS[budgetResult.code],
      code: budgetResult.code,
      message: budgetResult.message
    };
  }

  return { valid: true };
}

/**
 * 驗證 evidenceCandidates 陣列（批次）
 * @param {Array} candidates - EvidenceCandidate[]
 * @returns {{ valid: boolean, status?: string, code?: string, message?: string }}
 */
function validateEvidenceCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    return {
      valid: false,
      status: CODE_TO_STATUS[RUN_CODES.INVALID_EVIDENCE_CANDIDATE],
      code: RUN_CODES.INVALID_EVIDENCE_CANDIDATE,
      message: 'evidenceCandidates must be an array'
    };
  }

  for (let i = 0; i < candidates.length; i++) {
    const result = validateEvidenceCandidateShape(candidates[i]);
    if (!result.valid) {
      return {
        valid: false,
        status: CODE_TO_STATUS[result.code],
        code: result.code,
        message: `Invalid candidate at index ${i}: ${result.message}`
      };
    }
  }

  return { valid: true };
}

module.exports = {
  validateToolStep,
  validateEvidenceCandidates
};
