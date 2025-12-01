const crypto = require('crypto');

function stableId(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 16);
}

/**
 * 將來源資料映射為 CandidateLite
 * 期望來源欄位示例：
 * {
 *   id, url, text, lang, author, likes, comments, created_at, account_handle
 * }
 */
function mapToCandidateLite(item, opts = {}) {
  const platform = process.env.PLATFORM || opts.platform || 'threads';
  const text = item.text || '';
  const url = item.url || (item.id ? `post:${item.id}` : undefined);
  const author = item.author || '';
  const lang = item.lang || 'zh-Hant';
  const likes = Number.isFinite(item.likes) ? item.likes : 0;
  const comments = Number.isFinite(item.comments) ? item.comments : 0;
  const createdAt = item.created_at || item.posted_at_iso;
  const accountHandle = item.account_handle || (author ? `@${author}` : '@unknown');

  const candidateId = item.id || url || stableId(text);
  const originalLen = text ? text.length : (item.len || 0);
  const len = item.len || originalLen;

  return {
    platform,
    account: { handle: accountHandle },
    seed: { type: 'url', value: url || '' },
    features: {
      lang,
      author,
      len,
      engagement: { likes, comments },
      posted_at_iso: createdAt
    },
    context_digest: {
      target_snippet: text,
      original_len: originalLen,
      is_truncated: false
    },
    submitted_at: new Date().toISOString(),
    candidate_id: String(candidateId)
  };
}

module.exports = { mapToCandidateLite };
