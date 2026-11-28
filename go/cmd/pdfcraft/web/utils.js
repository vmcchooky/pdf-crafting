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

function reorderPageBlock(pages, movingIds, targetIndex) {
  const movingSet = new Set(movingIds || []);
  const movingPages = [];
  const remainingPages = [];
  for (const page of pages || []) {
    (movingSet.has(page.id) ? movingPages : remainingPages).push(page);
  }
  if (movingPages.length === 0 || remainingPages.length === 0) return [...(pages || [])];

  const index = Number.isFinite(targetIndex) ? Math.trunc(targetIndex) : 0;
  const insertAt = Math.max(0, Math.min(index, remainingPages.length));
  remainingPages.splice(insertAt, 0, ...movingPages);
  return remainingPages;
}

// ==========================================================================
// Project file validation (S4/S16)
// Pure functions — no DOM — testable with Node.
// ==========================================================================

/**
 * Giới hạn an toàn cho file project (.pdfcraft.json).
 * Ngăn file độc hại gây DoS (hàng nghìn source, pageIndex ngoài phạm vi,
 * dataUrl chứa script) hoặc XSS khi render lại.
 */
const PROJECT_LIMITS = {
  maxSources: 100,
  maxPages: 10000,
  maxGroups: 1000,
  maxStampsPerPage: 500,
  maxGroupNameLength: 120,
  maxTitleLength: 200,
  maxSourceNameLength: 255,
  maxDocMetaLength: 500,
  maxStampDataUrlBytes: 20 * 1024 * 1024, // 20 MB
  maxProjectFileBytes: 512 * 1024 * 1024, // 512 MB
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
// Base64 chuẩn (có padding), khớp output của arrayBufferToBase64.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Chỉ ảnh PNG/JPEG/WebP base64 — không data:text/html, không javascript:.
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * dataUrl có phải ảnh PNG/JPEG/WebP base64 hợp lệ, dưới giới hạn dung lượng?
 */
function isValidDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return false;
  if (dataUrl.length > PROJECT_LIMITS.maxStampDataUrlBytes) return false;
  if (!IMAGE_DATA_URL_RE.test(dataUrl)) return false;
  const payload = dataUrl.split(',')[1] || '';
  return payload.length % 4 === 0;
}

/**
 * Chỉ giữ các trường docMeta hợp lệ (string, cắt độ dài). Các giá trị
 * không phải string hoặc key lạ bị bỏ — không bao giờ render trực tiếp.
 */
function sanitizeDocMeta(docMeta) {
  const out = { title: '', author: '', subject: '', keywords: '', creator: '' };
  if (!docMeta || typeof docMeta !== 'object' || Array.isArray(docMeta)) return out;
  for (const key of Object.keys(out)) {
    if (typeof docMeta[key] === 'string') {
      out[key] = docMeta[key].slice(0, PROJECT_LIMITS.maxDocMetaLength);
    }
  }
  return out;
}

function isIntInRange(v, min, max) {
  return Number.isInteger(v) && v >= min && (max === undefined || v <= max);
}

/**
 * File project có vượt giới hạn 512 MB không? (S16)
 * Kiểm tra bằng file.size TRƯỚC khi file.text() — không đọc nội dung vào RAM.
 */
function isProjectFileTooLarge(fileSize) {
  return typeof fileSize === 'number' && fileSize > PROJECT_LIMITS.maxProjectFileBytes;
}

/**
 * Validate toàn bộ payload project TRƯỚC KHI chạm vào state hiện tại.
 * Trả về { ok, errors, docMeta } — docMeta là bản đã sanitize để loader dùng.
 * Lưu ý: pageIndex < numPages KHÔNG kiểm tra ở đây (cần mở PDF); loader
 * kiểm tra sau khi mở từng source và reject toàn bộ project nếu sai.
 */
function validateProjectPayload(project) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return { ok: false, errors: ['Project phải là một object JSON.'], docMeta: sanitizeDocMeta(null) };
  }
  if (project.app !== 'pdfcraft') fail('Trường "app" phải là "pdfcraft".');
  if (project.version !== undefined && (typeof project.version !== 'number' || !Number.isFinite(project.version))) {
    fail('Trường "version" phải là số.');
  }

  const docMeta = sanitizeDocMeta(project.docMeta);

  // ---- groups (validate trước vì pages tham chiếu groupIds) ----
  const groupIds = new Set();
  const groups = project.groups === undefined ? [] : project.groups;
  if (!Array.isArray(groups)) {
    fail('Trường "groups" phải là một mảng.');
  } else {
    if (groups.length > PROJECT_LIMITS.maxGroups) {
      fail(`Quá nhiều nhóm: ${groups.length} (tối đa ${PROJECT_LIMITS.maxGroups}).`);
    }
    groups.forEach((g, i) => {
      if (!g || typeof g !== 'object' || Array.isArray(g)) {
        fail(`groups[${i}] phải là một object.`);
        return;
      }
      if (!SAFE_ID_RE.test(String(g.id || ''))) {
        fail(`groups[${i}].id không hợp lệ (chỉ chữ/số/_/-, tối đa 64 ký tự).`);
      } else if (groupIds.has(g.id)) {
        fail(`groups[${i}].id trùng lặp: "${g.id}".`);
      } else {
        groupIds.add(g.id);
      }
      if (typeof g.name !== 'string' || g.name.length > PROJECT_LIMITS.maxGroupNameLength) {
        fail(`groups[${i}].name phải là chuỗi tối đa ${PROJECT_LIMITS.maxGroupNameLength} ký tự.`);
      }
      if (typeof g.color !== 'string' || !HEX_COLOR_RE.test(g.color)) {
        fail(`groups[${i}].color phải là mã hex dạng #RRGGBB.`);
      }
    });
  }

  // ---- sources ----
  if (!Array.isArray(project.sources)) {
    fail('Trường "sources" phải là một mảng.');
  } else {
    if (project.sources.length > PROJECT_LIMITS.maxSources) {
      fail(`Quá nhiều file nguồn: ${project.sources.length} (tối đa ${PROJECT_LIMITS.maxSources}).`);
    }
    project.sources.forEach((s, i) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        fail(`sources[${i}] phải là một object.`);
        return;
      }
      if (typeof s.name !== 'string' || s.name.length === 0 || s.name.length > PROJECT_LIMITS.maxSourceNameLength) {
        fail(`sources[${i}].name phải là chuỗi 1–${PROJECT_LIMITS.maxSourceNameLength} ký tự.`);
      }
      if (typeof s.data !== 'string' || s.data.length === 0 || !BASE64_RE.test(s.data)) {
        fail(`sources[${i}].data phải là base64 hợp lệ.`);
      }
      if (s.fileSize !== undefined && (typeof s.fileSize !== 'number' || !Number.isFinite(s.fileSize) || s.fileSize < 0)) {
        fail(`sources[${i}].fileSize phải là số >= 0.`);
      }
    });
  }
  const sourceCount = Array.isArray(project.sources) ? project.sources.length : 0;

  // ---- pages ----
  if (!Array.isArray(project.pages)) {
    fail('Trường "pages" phải là một mảng.');
  } else {
    if (project.pages.length > PROJECT_LIMITS.maxPages) {
      fail(`Quá nhiều trang: ${project.pages.length} (tối đa ${PROJECT_LIMITS.maxPages}).`);
    }
    project.pages.forEach((p, i) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        fail(`pages[${i}] phải là một object.`);
        return;
      }
      if (!isIntInRange(p.source, 0, sourceCount - 1)) {
        fail(`pages[${i}].source = ${JSON.stringify(p.source)} ngoài phạm vi (0–${sourceCount - 1}).`);
      }
      if (!isIntInRange(p.pageIndex, 0)) {
        fail(`pages[${i}].pageIndex phải là số nguyên >= 0.`);
      }
      if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > PROJECT_LIMITS.maxTitleLength)) {
        fail(`pages[${i}].title phải là chuỗi tối đa ${PROJECT_LIMITS.maxTitleLength} ký tự.`);
      }
      if (p.rotation !== undefined && ![0, 90, 180, 270].includes(p.rotation)) {
        fail(`pages[${i}].rotation phải là một trong 0/90/180/270.`);
      }
      if (p.groupIds !== undefined) {
        if (!Array.isArray(p.groupIds)) {
          fail(`pages[${i}].groupIds phải là một mảng.`);
        } else {
          p.groupIds.forEach((gid) => {
            if (!groupIds.has(gid)) fail(`pages[${i}].groupIds chứa id nhóm không tồn tại: "${gid}".`);
          });
        }
      }
      if (p.stamps !== undefined) {
        if (!Array.isArray(p.stamps)) {
          fail(`pages[${i}].stamps phải là một mảng.`);
        } else {
          if (p.stamps.length > PROJECT_LIMITS.maxStampsPerPage) {
            fail(`pages[${i}] có quá nhiều dấu: ${p.stamps.length} (tối đa ${PROJECT_LIMITS.maxStampsPerPage}).`);
          }
          p.stamps.forEach((st, j) => {
            if (!st || typeof st !== 'object' || Array.isArray(st)) {
              fail(`pages[${i}].stamps[${j}] phải là một object.`);
              return;
            }
            if (!SAFE_ID_RE.test(String(st.id || ''))) {
              fail(`pages[${i}].stamps[${j}].id không hợp lệ.`);
            }
            if (!isValidDataUrl(st.dataUrl)) {
              fail(`pages[${i}].stamps[${j}].dataUrl phải là data:image/(png|jpeg|webp);base64, tối đa 20 MB.`);
            }
            for (const k of ['relX', 'relY', 'relW', 'relH']) {
              if (st[k] !== undefined && (typeof st[k] !== 'number' || !Number.isFinite(st[k]) || st[k] < 0 || st[k] > 1)) {
                fail(`pages[${i}].stamps[${j}].${k} phải là số trong [0, 1].`);
              }
            }
            if (st.rotation !== undefined && (typeof st.rotation !== 'number' || !Number.isFinite(st.rotation))) {
              fail(`pages[${i}].stamps[${j}].rotation phải là số.`);
            }
            if (st.opacity !== undefined && (typeof st.opacity !== 'number' || !Number.isFinite(st.opacity) || st.opacity < 0 || st.opacity > 1)) {
              fail(`pages[${i}].stamps[${j}].opacity phải là số trong [0, 1].`);
            }
          });
        }
      }
    });
  }

  return { ok: errors.length === 0, errors, docMeta };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LRUCache, escapeHtml, formatBytes, normalizeText, findTextMatches, remapOutlineTree, reorderPageBlock, validateProjectPayload, sanitizeDocMeta, isValidDataUrl, isProjectFileTooLarge, PROJECT_LIMITS };
}
