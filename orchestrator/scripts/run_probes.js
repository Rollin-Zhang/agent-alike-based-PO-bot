#!/usr/bin/env node
/**
 * run_probes.js - CLI entry point for Startup Probes
 * 
 * Phase A & B: Deterministic Safety Skeleton + Real MCP Enforcement
 * 
 * Usage:
 *   node orchestrator/scripts/run_probes.js
 * 
 * Environment variables:
 *   NO_MCP=true              - Explicit NoMcpProvider
 *   MCP_CONFIG_PATH=<path>   - Path to MCP config (triggers RealMcpProvider)
 *   RUN_REAL_MCP_TESTS=true  - Explicit opt-in for RealMcpProvider
 *   PROBE_FORCE_FAIL=<name>  - Force a specific probe to fail (deterministic testing)
 * 
 * Provider selection (defensive fallback):
 *   1. NO_MCP=true → NoMcpProvider
 *   2. RUN_REAL_MCP_TESTS=true OR MCP_CONFIG_PATH exists → RealMcpProvider
 *   3. Otherwise → NoMcpProvider:fallback (won't explode on fresh clone)
 * 
 * Exit codes:
 *   0 - All probes passed
 *   1 - At least one probe failed (fail-fast in production)
 * 
 * Output:
 *   JSON report to stdout with structure:
 *   {
 *     "allPassed": boolean,
 *     "exitCode": number,
 *     "forceFailName": string|null,
 *     "provider": string,
 *     "results": [{ name, ok, code, forced, provider, timestamp }, ...]
 *   }
 */

const { ProbeRunner, createProviderFromEnv } = require('../probes/ProbeRunner');
const fs = require('fs');
const { attachEvidence } = require('../lib/evidence/attachEvidence');
const { EvidenceStore } = require('../lib/evidence/EvidenceStore');
const { getEvidenceLimitsFromEnv } = require('../lib/evidence/ssot');

async function collectProbeEvidence({ results, limits }) {
  // Decision #6: maxItemsStrategy is fixed to keep_first_n.
  // Ordering semantics: "first" means probe execution order (currently registry order).
  const maxItemsPerReport = Number.isInteger(limits.maxItemsPerReport) ? limits.maxItemsPerReport : 0;
  if (maxItemsPerReport <= 0) {
    return { evidence: [], evidence_dropped_count: results.length, evidence_truncated: results.length > 0 };
  }

  const store = new EvidenceStore();
  const evidence = [];

  for (const r of results.slice(0, maxItemsPerReport)) {
    // Keep bytes tiny to avoid disk writes by default (inline path).
    // Full structured info remains in report.results; evidence is a governed, stable-by-contract attachment.
    const bytes = Buffer.from(`${r.name}|${r.ok ? 1 : 0}|${r.code}|${r.forced ? 1 : 0}|${r.provider}`, 'utf8');

    const { item } = await attachEvidence({
      kind: 'probe_log',
      source: `probe:${r.name}`,
      retrieved_at: r.timestamp,
      metadata: {
        probe_name: r.name,
        probe_ok: r.ok,
        probe_code: r.code,
        probe_forced: r.forced,
        probe_provider: r.provider
      },
      bytes,
      limits,
      store
    });

    evidence.push(item);
  }

  const evidence_dropped_count = Math.max(0, results.length - evidence.length);
  const evidence_truncated = evidence_dropped_count > 0;
  return { evidence, evidence_dropped_count, evidence_truncated };
}

async function main() {
  // Read environment
  const noMcp = process.env.NO_MCP === 'true';
  const realMcpTests = process.env.RUN_REAL_MCP_TESTS === 'true';
  const configPath = process.env.MCP_CONFIG_PATH || null;
  const forceFailName = process.env.PROBE_FORCE_FAIL || null;

  // Compute provider selection metadata (for debugging)
  // Priority matches createProviderFromEnv(): NO_MCP > RUN_REAL_MCP_TESTS > MCP_CONFIG_PATH_EXISTS > FALLBACK
  const mcpConfigPathExists = Boolean(configPath && fs.existsSync(configPath));
  let provider_selected_reason;
  if (noMcp) {
    provider_selected_reason = 'NO_MCP';
  } else if (realMcpTests) {
    provider_selected_reason = 'RUN_REAL_MCP_TESTS';
  } else if (mcpConfigPathExists) {
    provider_selected_reason = 'MCP_CONFIG_PATH_EXISTS';
  } else {
    provider_selected_reason = 'FALLBACK_NO_CONFIG';
  }

  const mcp_config_path_used = mcpConfigPathExists ? configPath : null;

  // Create provider (defensive fallback logic)
  const provider = createProviderFromEnv({ noMcp, configPath, realMcpTests });
  await provider.initialize();

  // Create runner with force-fail config
  const runner = new ProbeRunner({ forceFailName });

  // Run all probes
  const { results, allPassed } = await runner.runAll({ provider });

  // Cleanup provider
  await provider.cleanup();

  // Determine exit code
  const exitCode = allPassed ? 0 : 1;

  // Build report
  const evidence_limits = getEvidenceLimitsFromEnv(process.env);
  const { evidence, evidence_dropped_count, evidence_truncated } = await collectProbeEvidence({ results, limits: evidence_limits });
  const report = {
    allPassed,
    exitCode,
    forceFailName,
    provider: provider.name,
    provider_selected_reason,
    mcp_config_path_used,
    timestamp: new Date().toISOString(),
    results,
    // M2-A.2: Evidence governance (minimal integration): keep_first_n collection from probe results.
    evidence,
    evidence_truncated,
    evidence_dropped_count
  };

  // Output JSON report to stdout
  console.log(JSON.stringify(report, null, 2));

  // Exit with appropriate code (fail-fast in production)
  process.exit(exitCode);
}

main().catch(err => {
  // Fatal error in probe runner itself
  const errorReport = {
    allPassed: false,
    exitCode: 1,
    forceFailName: process.env.PROBE_FORCE_FAIL || null,
    provider: 'unknown',
    timestamp: new Date().toISOString(),
    fatalError: true,
    results: [],
    // M2-A.2: Evidence governance integration point (may be empty).
    evidence: []
  };
  console.log(JSON.stringify(errorReport, null, 2));
  process.exit(1);
});
