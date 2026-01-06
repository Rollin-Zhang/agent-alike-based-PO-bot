'use strict';

function canonicalJsonStringify(value) {
  return _stringify(value);
}

function _stringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (Array.isArray(value)) {
    return '[' + value.map(_stringify).join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + _stringify(v));
    }
    return '{' + parts.join(',') + '}';
  }

  // functions/symbols
  return 'null';
}

module.exports = {
  canonicalJsonStringify,
  CANONICALIZER_ID: 'canonicalJsonStringify/v1'
};
