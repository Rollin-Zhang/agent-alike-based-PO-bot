/**
 * cutoverMetrics.js (M2-C.1)
 * Low-cardinality counters for cutover observability.
 *
 * Labels MUST be low-cardinality:
 * - event_type: legacy_read | cutover_violation | canonical_missing
 * - field: e.g., 'tool_verdict'
 *
 * Optional 'source' is supported but should remain low-cardinality.
 */

const ALLOWED_EVENT_TYPES = new Set([
  'legacy_read',
  'cutover_violation',
  'canonical_missing'
]);

function createCutoverMetrics() {
  // key: `${event_type}|${field}|${source}`
  const counters = new Map();

  function _normLabel(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function _key({ event_type, field, source }) {
    return `${_normLabel(event_type)}|${_normLabel(field)}|${_normLabel(source)}`;
  }

  function inc(event_type, field, labels = {}) {
    if (!ALLOWED_EVENT_TYPES.has(event_type)) {
      throw new Error(`cutoverMetrics: unsupported event_type: ${event_type}`);
    }
    if (!field) {
      throw new Error('cutoverMetrics: field is required');
    }

    const source = labels && labels.source ? _normLabel(labels.source) : '';
    const k = _key({ event_type, field, source });
    counters.set(k, (counters.get(k) || 0) + 1);
  }

  function snapshot() {
    // aggregate by event_type+field; also expose per-source breakdown if present.
    const by_event_field = {};
    const by_event_field_source = {};

    for (const [k, count] of counters.entries()) {
      const [event_type, field, source] = k.split('|');
      const k1 = `${event_type}|${field}`;
      by_event_field[k1] = (by_event_field[k1] || 0) + count;

      if (source) {
        const k2 = `${event_type}|${field}|${source}`;
        by_event_field_source[k2] = (by_event_field_source[k2] || 0) + count;
      }
    }

    function toObj(mapObj, splitLen) {
      const out = [];
      for (const [k, v] of Object.entries(mapObj)) {
        const parts = k.split('|');
        const row = { event_type: parts[0], field: parts[1], count: v };
        if (splitLen === 3) row.source = parts[2];
        out.push(row);
      }
      // Stable ordering for tests/metrics.
      out.sort((a, b) => {
        if (a.event_type !== b.event_type) return a.event_type.localeCompare(b.event_type);
        if (a.field !== b.field) return a.field.localeCompare(b.field);
        return (a.source || '').localeCompare(b.source || '');
      });
      return out;
    }

    const countersOut = toObj(by_event_field, 2);
    const bySourceOut = toObj(by_event_field_source, 3);

    // Test-only deterministic injection (Phase E Level 2)
    // - Do not affect production behavior; only influences observability snapshot.
    if (process.env.NODE_ENV === 'test' && String(process.env.CANONICAL_MISSING_FORCE) === '1') {
      const hit = countersOut.find((r) => r.event_type === 'canonical_missing' && r.field === 'tool_verdict');
      if (hit) {
        hit.count = Number(hit.count || 0) + 1;
      } else {
        countersOut.push({ event_type: 'canonical_missing', field: 'tool_verdict', count: 1 });
        countersOut.sort((a, b) => {
          if (a.event_type !== b.event_type) return a.event_type.localeCompare(b.event_type);
          if (a.field !== b.field) return a.field.localeCompare(b.field);
          return (a.source || '').localeCompare(b.source || '');
        });
      }
    }

    return {
      counters: countersOut,
      counters_by_source: bySourceOut
    };
  }

  function reset() {
    counters.clear();
  }

  return { inc, snapshot, reset };
}

// Default singleton used by server and core libs.
const cutoverMetrics = createCutoverMetrics();

module.exports = {
  createCutoverMetrics,
  cutoverMetrics
};
