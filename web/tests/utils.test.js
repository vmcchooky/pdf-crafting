/**
 * Node tests for web/utils.js (pure functions, no DOM).
 * Run: node --test web/tests/
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { LRUCache, escapeHtml, formatBytes, normalizeText, findTextMatches } = require('../utils.js');

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const c = new LRUCache(3);
    c.set('a', 1);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('missing'), null);
    assert.equal(c.has('a'), true);
  });

  it('evicts least-recently-used item when full', () => {
    const c = new LRUCache(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // 'a' becomes most-recently-used
    c.set('c', 3); // evicts 'b'
    assert.equal(c.has('b'), false);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('c'), 3);
  });

  it('closes bitmap of evicted items', () => {
    const c = new LRUCache(1);
    let closed = false;
    c.set('a', { bitmap: { close: () => { closed = true; } } });
    c.set('b', 2);
    assert.equal(closed, true);
  });

  it('delete and clear release bitmaps', () => {
    const c = new LRUCache(4);
    let n = 0;
    c.set('a', { bitmap: { close: () => { n++; } } });
    c.delete('a');
    assert.equal(n, 1);
    c.set('b', { bitmap: { close: () => { n++; } } });
    c.clear();
    assert.equal(n, 2);
    assert.equal(c.size, 0);
  });
});

describe('escapeHtml', () => {
  it('escapes special chars', () => {
    assert.equal(escapeHtml('<a href="x">&\'y\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#039;y&#039;&lt;/a&gt;');
  });

  it('handles empty input', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
  });
});

describe('formatBytes', () => {
  it('formats B, KB, MB', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
  });
});

describe('normalizeText', () => {
  it('lowercases and strips Vietnamese diacritics', () => {
    assert.equal(normalizeText('BÁO CÁO Q3'), 'bao cao q3');
    assert.equal(normalizeText('Nguyễn Văn An'), 'nguyen van an');
    assert.equal(normalizeText('ĐÃ THU TIỀN'), 'da thu tien');
  });

  it('handles empty input', () => {
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText(null), '');
  });
});

describe('findTextMatches', () => {
  const pages = [
    { id: 'p1', text: 'Báo cáo tài chính Q3' },
    { id: 'p2', text: 'Hợp đồng lao động' },
    { id: 'p3', text: 'báo cáo báo cáo' },
  ];

  it('finds accent-insensitive matches', () => {
    const res = findTextMatches(pages, 'bao cao');
    assert.deepEqual(res, [{ id: 'p1', matches: 1 }, { id: 'p3', matches: 2 }]);
  });

  it('is case-insensitive', () => {
    const res = findTextMatches(pages, 'HỢP ĐỒNG');
    assert.deepEqual(res, [{ id: 'p2', matches: 1 }]);
  });

  it('returns [] for empty query', () => {
    assert.deepEqual(findTextMatches(pages, '   '), []);
    assert.deepEqual(findTextMatches(pages, ''), []);
  });

  it('supports accent-sensitive mode', () => {
    const res = findTextMatches(pages, 'bao cao', { accentInsensitive: false });
    assert.deepEqual(res, []);
  });
});
