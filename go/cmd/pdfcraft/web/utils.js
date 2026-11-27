/**
 * PDF Craft - Shared pure utilities (no DOM).
 * Loaded as a classic script before app.js in the browser (globals),
 * and required by Node tests via module.exports (see web/tests/).
 */

class LRUCache {
  constructor(maxSize = 12) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    // Move to most recently used
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, val) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest item (first item in Map)
      const oldestKey = this.cache.keys().next().value;
      const oldestItem = this.cache.get(oldestKey);
      if (oldestItem && oldestItem.bitmap && typeof oldestItem.bitmap.close === 'function') {
        oldestItem.bitmap.close();
      }
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, val);
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    const item = this.cache.get(key);
    if (item && item.bitmap && typeof item.bitmap.close === 'function') {
      item.bitmap.close();
    }
    this.cache.delete(key);
  }

  clear() {
    this.cache.forEach(item => {
      if (item && item.bitmap && typeof item.bitmap.close === 'function') {
        item.bitmap.close();
      }
    });
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Chuẩn hóa text để tìm kiếm không phân biệt dấu tiếng Việt.
 * "BÁO CÁO" -> "bao cao", "Nguyễn" -> "nguyen".
 */
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

/**
 * Tìm query trong danh sách trang [{ id, text }].
 * Trả về [{ id, matches }] chỉ gồm các trang có ít nhất 1 kết quả.
 */
function findTextMatches(pages, query, options) {
  const opts = Object.assign({ accentInsensitive: true }, options);
  const norm = (s) => opts.accentInsensitive
    ? normalizeText(s)
    : String(s || '').toLowerCase();
  const q = norm(query).trim();
  if (!q) return [];

  const out = [];
  for (const p of pages || []) {
    const t = norm(p && p.text);
    let count = 0;
    let idx = t.indexOf(q);
    while (idx !== -1) {
      count++;
      idx = t.indexOf(q, idx + q.length);
    }
    if (count > 0) out.push({ id: p.id, matches: count });
  }
  return out;
}

/**
 * Remap PDF.js outline nodes to 1-based output pages.
 * outputPageBySource maps a source page index to its first output occurrence.
 * Nodes targeting omitted pages are removed while surviving children are kept
 * at the same level; structural headings inherit their first child's target.
 */
function remapOutlineTree(items, outputPageBySource) {
  const out = [];
  for (const item of items || []) {
    const kids = remapOutlineTree(item.kids || [], outputPageBySource);
    const hasTarget = Number.isInteger(item.pageIndex);
    const page = hasTarget ? outputPageBySource.get(item.pageIndex) : null;

    if (hasTarget && !Number.isInteger(page)) {
      out.push(...kids);
      continue;
    }
    if (!Number.isInteger(page) && kids.length === 0) continue;

    out.push({
      title: String(item.title || '(không tên)'),
      page: Number.isInteger(page) ? page : kids[0].page,
      kids,
    });
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LRUCache, escapeHtml, formatBytes, normalizeText, findTextMatches, remapOutlineTree };
}
