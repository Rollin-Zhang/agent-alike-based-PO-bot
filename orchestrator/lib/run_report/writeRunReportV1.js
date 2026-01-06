'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Single writer helper for run_report_v1.json
 * - Centralizes JSON formatting and ensures a single injection point for run-level fields.
 */
function writeRunReportV1(options = {}) {
  const {
    filePath,
    reportV1,
    mode_snapshot = undefined
  } = options;

  if (!filePath || typeof filePath !== 'string') {
    throw new Error('writeRunReportV1: filePath is required');
  }
  if (!reportV1 || typeof reportV1 !== 'object') {
    throw new Error('writeRunReportV1: reportV1 is required');
  }

  if (mode_snapshot && typeof mode_snapshot === 'object') {
    reportV1.mode_snapshot = mode_snapshot;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(reportV1, null, 2) + '\n', 'utf8');
}

module.exports = {
  writeRunReportV1
};
