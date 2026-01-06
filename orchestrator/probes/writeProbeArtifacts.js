/**
 * Probe Artifacts Writer (Phase D)
 * 
 * 負責將 probes 執行結果寫入 ./logs（符合 blueprint filesystem allowlist）
 * 
 * 產物：
 * - dep_snapshot.v1.json（dependency readiness snapshot）
 * - startup_probe_report.v1.json（startup probes report）
 * 
 * 可選：run_id 子目錄（例如 ./logs/startup_probes/<run_id>/）
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 取得 logs 目錄
 * - 預設：repo_root/./logs
 * - 測試/CI：可用 LOGS_DIR 覆寫，避免污染工作區
 */
function getLogsDir() {
  const override = process.env.LOGS_DIR;
  if (override && typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.resolve(__dirname, '../../logs');
}

/**
 * 確保目錄存在
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 寫入 dep_snapshot.v1.json
 * 
 * @param {Object} snapshot - Dep snapshot object (must conform to dep_snapshot.v1.schema.json)
 * @param {Object} options
 * @param {string} [options.run_id] - Optional run_id for subdirectory
 * @returns {string} Written file path (relative to logs/)
 */
function writeDepSnapshot(snapshot, options = {}) {
  const { run_id } = options;

  // Validate snapshot has required fields
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('snapshot must be an object');
  }
  if (!snapshot.snapshot_id) {
    throw new Error('snapshot.snapshot_id is required');
  }
  if (!Array.isArray(snapshot.missing_dep_codes)) {
    throw new Error('snapshot.missing_dep_codes must be an array');
  }

  // Determine path
  const logsDir = getLogsDir();
  let targetDir = logsDir;
  let relativePath = 'dep_snapshot.v1.json';

  if (run_id) {
    targetDir = path.join(logsDir, 'startup_probes', run_id);
    relativePath = path.join('startup_probes', run_id, 'dep_snapshot.v1.json');
  }

  ensureDir(targetDir);

  const filePath = path.join(targetDir, 'dep_snapshot.v1.json');
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');

  return relativePath;
}

/**
 * 寫入 startup_probe_report.v1.json
 * 
 * @param {Object} report - Startup probe report object (must conform to startup_probe_report.v1.schema.json)
 * @param {Object} options
 * @param {string} [options.run_id] - Optional run_id for subdirectory
 * @returns {string} Written file path (relative to logs/)
 */
function writeStartupProbeReport(report, options = {}) {
  const { run_id } = options;

  // Validate report has required fields
  if (!report || typeof report !== 'object') {
    throw new Error('report must be an object');
  }
  if (!report.report_id) {
    throw new Error('report.report_id is required');
  }
  if (!Array.isArray(report.step_reports)) {
    throw new Error('report.step_reports must be an array');
  }

  // Determine path
  const logsDir = getLogsDir();
  let targetDir = logsDir;
  let relativePath = 'startup_probe_report.v1.json';

  if (run_id) {
    targetDir = path.join(logsDir, 'startup_probes', run_id);
    relativePath = path.join('startup_probes', run_id, 'startup_probe_report.v1.json');
  }

  ensureDir(targetDir);

  const filePath = path.join(targetDir, 'startup_probe_report.v1.json');
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');

  return relativePath;
}

/**
 * 建立 dep_snapshot（從 readiness depStates）
 * 
 * @param {Object} params
 * @param {Object} params.depStates - Dep states from ToolGateway.getDepStates()
 * @param {string} params.snapshot_id - Unique snapshot ID (externally injected)
 * @param {string} params.as_of - ISO8601 timestamp (externally injected)
 * @param {string} [params.probe_context] - Optional context
 * @returns {Object} Dep snapshot v1
 */
function createDepSnapshot(params) {
  const { depStates, snapshot_id, as_of, probe_context = 'startup_probes' } = params;

  if (!snapshot_id) {
    throw new Error('snapshot_id must be externally injected (no random UUID)');
  }
  if (!as_of) {
    throw new Error('as_of must be externally injected (no clock read)');
  }

  const required_deps = {};
  const optional_deps = {};
  const missing_dep_codes = [];

  for (const [depKey, depState] of Object.entries(depStates)) {
    const entry = {
      ready: depState.ready || false,
      code: depState.code || 'UNKNOWN'
    };

    if (depState.message) {
      entry.message = depState.message;
    }

    // Classify as required or optional (simplified: all deps treated as required for now)
    required_deps[depKey] = entry;

    // Collect missing dep codes
    if (!depState.ready) {
      missing_dep_codes.push(depState.code || 'DEP_UNAVAILABLE');
    }
  }

  return {
    version: 'v1',
    snapshot_id,
    as_of,
    missing_dep_codes: [...new Set(missing_dep_codes)], // deduplicate
    required_deps,
    optional_deps,
    probe_context
  };
}

module.exports = {
  writeDepSnapshot,
  writeStartupProbeReport,
  createDepSnapshot,
  getLogsDir
};
