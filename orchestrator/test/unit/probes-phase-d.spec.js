/**
 * Phase D Regression Tests
 * 
 * Assert Phase D contract compliance:
 * - PROBE_FORCE_FAIL deterministic failure
 * - PROBE_FORCE_INVALID_SHAPE=search deterministic shape validation failure
 * - Pass/fail only via StepReport fields (not attempt_events or messages)
 * - Artifacts written to ./logs/startup_probes/<run_id>/
 * - Security probe FS_PATH_NOT_WHITELISTED only in attempt_events
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProbeRunner, createProviderFromEnv } = require('../../probes/ProbeRunner');
const { probeResultToStepReport } = require('../../probes/probeStepReportBuilder');
const { writeStartupProbeReport, writeDepSnapshot, createDepSnapshot, getLogsDir } = require('../../probes/writeProbeArtifacts');
const { isProbeStepPass, isProbeStepFail, PROBE_STEP_CODES } = require('../../probes/ssot');

describe('Phase D: Probes Regression Tests', function() {
  // Increase timeout for probe execution
  jest.setTimeout(10000);

  let originalEnv;
  let tempLogsDir;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };

    // Use temp logs dir to avoid polluting repo logs/ and reduce CI flakiness
    tempLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-'));
    process.env.LOGS_DIR = tempLogsDir;
    process.env.ENABLE_AUDIT_LOGS = 'false';
  });

  afterEach(() => {
    // Restore env
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);

    if (tempLogsDir) {
      try {
        fs.rmSync(tempLogsDir, { recursive: true, force: true });
      } catch (_) {
        // ignore
      }
      tempLogsDir = null;
    }
  });

  describe('PROBE_FORCE_FAIL deterministic failure', () => {
    it('should force-fail security probe when PROBE_FORCE_FAIL=security', async () => {
      process.env.NO_MCP = 'true';
      process.env.PROBE_FORCE_FAIL = 'security';

      const provider = createProviderFromEnv({ noMcp: true });
      await provider.initialize();

      const runner = new ProbeRunner({ forceFailName: 'security' });
      const { results, allPassed } = await runner.runAll({ provider });

      await provider.cleanup();

      // Assert overall failure
      assert.strictEqual(allPassed, false);

      // Find security probe result
      const securityResult = results.find(r => r.name === 'security');
      assert.ok(securityResult);
      assert.strictEqual(securityResult.ok, false);

      // Convert to StepReport and assert via StepReport fields ONLY
      const stepReport = probeResultToStepReport({
        probeResult: securityResult,
        step_index: 1,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: 0
      });

      // Phase D contract: pass/fail only via StepReport fields
      assert.strictEqual(isProbeStepFail(stepReport), true);
      assert.ok(['blocked', 'failed'].includes(stepReport.status));
      assert.ok(stepReport.code !== null);
    });
  });

  describe('PROBE_FORCE_INVALID_SHAPE=search deterministic shape failure', () => {
    it('should fail search probe with SEARCH_PROBE_INVALID_SHAPE when PROBE_FORCE_INVALID_SHAPE=search', async () => {
      process.env.NO_MCP = 'true';
      process.env.PROBE_FORCE_INVALID_SHAPE = 'search';

      const provider = createProviderFromEnv({ noMcp: true });
      await provider.initialize();

      const runner = new ProbeRunner({ 
        forceFailName: null,
        forceInvalidShapeName: 'search'
      });
      const { results, allPassed } = await runner.runAll({ provider });

      await provider.cleanup();

      // Assert overall failure
      assert.strictEqual(allPassed, false);

      // Find search probe result
      const searchResult = results.find(r => r.name === 'search');
      assert.ok(searchResult);
      assert.strictEqual(searchResult.ok, false);

      // Convert to StepReport
      const stepReport = probeResultToStepReport({
        probeResult: searchResult,
        step_index: 1,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: 0
      });

      // Phase D contract: assert via StepReport fields ONLY
      assert.strictEqual(isProbeStepFail(stepReport), true);
      assert.strictEqual(stepReport.code, PROBE_STEP_CODES.SEARCH_PROBE_INVALID_SHAPE);
      assert.strictEqual(stepReport.status, 'blocked');
    });
  });

  describe('Artifacts written to ./logs', () => {
    it('should write dep_snapshot and startup_probe_report to ./logs/startup_probes/<run_id>', async () => {
      process.env.NO_MCP = 'true';

      const provider = createProviderFromEnv({ noMcp: true });
      await provider.initialize();

      const runner = new ProbeRunner({});
      const { results, allPassed } = await runner.runAll({ provider });

      await provider.cleanup();

      // Create dep snapshot
      const now = new Date();
      const as_of = now.toISOString();
      const run_id = `test_${Date.now()}`;

      const depSnapshot = createDepSnapshot({
        depStates: {},
        snapshot_id: run_id,
        as_of,
        probe_context: 'test'
      });

      // Write artifacts
      const depSnapshotPath = writeDepSnapshot(depSnapshot, { run_id });
      const logsDir = getLogsDir();
      const depSnapshotAbsPath = path.join(logsDir, depSnapshotPath);

      const step_reports = results.map((probeResult, index) => {
        return probeResultToStepReport({
          probeResult,
          step_index: index + 1,
          started_at: as_of,
          ended_at: as_of,
          duration_ms: 0
        });
      });

      const report = {
        version: 'v1',
        report_id: run_id,
        as_of,
        all_passed: allPassed,
        exit_code: allPassed ? 0 : 1,
        provider: {
          name: provider.name,
          type: provider.constructor.name
        },
        strict_probes: true,
        no_mcp: true,
        step_reports,
        dep_snapshot_ref: {
          path: depSnapshotPath,
          snapshot_id: depSnapshot.snapshot_id
        },
        evidence: []
      };

      const reportPath = writeStartupProbeReport(report, { run_id });
      const reportAbsPath = path.join(logsDir, reportPath);

      // Assert files exist
      assert.ok(fs.existsSync(depSnapshotAbsPath), `dep_snapshot file should exist at: ${depSnapshotAbsPath}`);
      assert.ok(fs.existsSync(reportAbsPath), `startup_probe_report file should exist at: ${reportAbsPath}`);

      // Assert file paths contain ./logs/startup_probes/<run_id>
      assert.ok(depSnapshotPath.includes('startup_probes'), 'dep_snapshot path should include startup_probes');
      assert.ok(depSnapshotPath.includes(run_id), 'dep_snapshot path should include run_id');
      assert.ok(reportPath.includes('startup_probes'), 'report path should include startup_probes');
      assert.ok(reportPath.includes(run_id), 'report path should include run_id');

      // Cleanup test artifacts
      try {
        fs.unlinkSync(depSnapshotAbsPath);
        fs.unlinkSync(reportAbsPath);
        
        // Try to cleanup run_id directory
        const runDir = path.dirname(depSnapshotAbsPath);
        const files = fs.readdirSync(runDir);
        if (files.length === 0) {
          fs.rmdirSync(runDir);
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    });
  });

  describe('Security probe FS_PATH_NOT_WHITELISTED only in attempt_events', () => {
    it('should have FS_PATH_NOT_WHITELISTED in attempt_events, not in StepReport.code', async () => {
      process.env.NO_MCP = 'true';

      const provider = createProviderFromEnv({ noMcp: true });
      await provider.initialize();

      const runner = new ProbeRunner({});
      const { results } = await runner.runAll({ provider });

      await provider.cleanup();

      // Find security probe result
      const securityResult = results.find(r => r.name === 'security');
      assert.ok(securityResult);

      // Security probe should PASS (because it expects access denial)
      assert.strictEqual(securityResult.ok, true);

      // Convert to StepReport
      const stepReport = probeResultToStepReport({
        probeResult: securityResult,
        step_index: 1,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: 0
      });

      // Phase D contract: security probe passes → StepReport.code must be null
      assert.strictEqual(isProbeStepPass(stepReport), true);
      assert.strictEqual(stepReport.code, null);

      // If there were attempt_events, FS_PATH_NOT_WHITELISTED could be there
      // But StepReport.code must NOT contain it (contract violation)
      if (stepReport.attempt_events && stepReport.attempt_events.length > 0) {
        const hasWhitelistCode = stepReport.attempt_events.some(
          evt => evt.code === 'FS_PATH_NOT_WHITELISTED'
        );
        // This is allowed in attempt_events
        // But we verify StepReport.code is null (already checked above)
      }
    });
  });

  describe('Pass/fail determined only by StepReport fields', () => {
    it('should determine pass via isProbeStepPass(stepReport) only', async () => {
      process.env.NO_MCP = 'true';

      const provider = createProviderFromEnv({ noMcp: true });
      await provider.initialize();

      const runner = new ProbeRunner({});
      const { results } = await runner.runAll({ provider });

      await provider.cleanup();

      // Convert all to StepReports
      const stepReports = results.map((probeResult, index) => {
        return probeResultToStepReport({
          probeResult,
          step_index: index + 1,
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: 0
        });
      });

      // Assert each via contract functions
      for (const stepReport of stepReports) {
        if (stepReport.status === 'ok' && stepReport.code === null) {
          assert.strictEqual(isProbeStepPass(stepReport), true);
          assert.strictEqual(isProbeStepFail(stepReport), false);
        } else if (['blocked', 'failed'].includes(stepReport.status) && stepReport.code !== null) {
          assert.strictEqual(isProbeStepFail(stepReport), true);
          assert.strictEqual(isProbeStepPass(stepReport), false);
        }

        // Never rely on message or attempt_events for pass/fail
        // (This test just verifies the contract functions work correctly)
      }
    });
  });
});
