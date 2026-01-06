/**
 * Search Shape Gate (Phase D)
 * 
 * 驗證 search probe response 是否符合預期結構
 * - 用於 Search probe（不依賴 hits 有無，只看結構有效性）
 * - 支援 PROBE_FORCE_INVALID_SHAPE=search 注入無效 shape
 */

'use strict';

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const fs = require('fs');
const path = require('path');

// Load schema
const schemaPath = path.resolve(__dirname, '../schemas/web_search_response.v1.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

// Create validator
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

/**
 * 驗證 search response shape
 * 
 * @param {any} response - Response from search tool
 * @returns {{ valid: boolean, errors?: Array }}
 */
function validateSearchShape(response) {
  const valid = validate(response);
  
  if (!valid) {
    return {
      valid: false,
      errors: validate.errors
    };
  }
  
  return { valid: true };
}

/**
 * 產生無效 shape（用於 PROBE_FORCE_INVALID_SHAPE=search）
 * 
 * @returns {Object} Invalid response (missing required field)
 */
function createInvalidSearchShape() {
  return {
    // Missing required 'summaries' field
    query: 'forced_invalid_shape',
    invalid: true
  };
}

module.exports = {
  validateSearchShape,
  createInvalidSearchShape
};
