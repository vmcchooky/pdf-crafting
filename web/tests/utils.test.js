/**
 * Node tests for web/utils.js (pure functions, no DOM).
 * Run: node --test web/tests/
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { LRUCache, escapeHtml, formatBytes, normalizeText, findTextMatches, remapOutlineTree, reorderPageBlock } = require('../utils.js');

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

describe('remapOutlineTree', () => {
  it('maps nested bookmarks to the first exported page numbers', () => {
    const tree = remapOutlineTree([
      { title: 'Part A', pageIndex: 2, kids: [{ title: 'Details', pageIndex: 0, kids: [] }] },
    ], new Map([[0, 2], [2, 1]]));
    assert.deepEqual(tree, [
      { title: 'Part A', page: 1, kids: [{ title: 'Details', page: 2, kids: [] }] },
    ]);
  });

  it('drops omitted targets and promotes surviving children', () => {
    const tree = remapOutlineTree([
      { title: 'Removed page', pageIndex: 4, kids: [{ title: 'Kept child', pageIndex: 1, kids: [] }] },
    ], new Map([[1, 3]]));
    assert.deepEqual(tree, [{ title: 'Kept child', page: 3, kids: [] }]);
  });

  it('keeps structural headings and uses their first child as destination', () => {
    const tree = remapOutlineTree([
      { title: 'Heading', pageIndex: null, kids: [{ title: 'Section', pageIndex: 2, kids: [] }] },
    ], new Map([[2, 4]]));
    assert.deepEqual(tree, [
      { title: 'Heading', page: 4, kids: [{ title: 'Section', page: 4, kids: [] }] },
    ]);
  });
});

describe('reorderPageBlock', () => {
  const pages = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
  const ids = orderedPages => orderedPages.map(page => page.id);

  it('moves a contiguous block one position left or right', () => {
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'c'], 0)), ['b', 'c', 'a', 'd', 'e']);
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'c'], 2)), ['a', 'd', 'b', 'c', 'e']);
  });

  it('gathers non-contiguous pages at the collapsed block position', () => {
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'd'], 0)), ['b', 'd', 'a', 'c', 'e']);
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'd'], 1)), ['a', 'b', 'd', 'c', 'e']);
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'd'], 2)), ['a', 'c', 'b', 'd', 'e']);
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'd'], 3)), ['a', 'c', 'e', 'b', 'd']);
  });

  it('preserves current selected order regardless of moving ID order', () => {
    assert.deepEqual(ids(reorderPageBlock(pages, new Set(['d', 'b']), 3)), ['a', 'c', 'e', 'b', 'd']);
  });

  it('preserves the relative order of unselected pages', () => {
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'd'], 2)), ['a', 'c', 'b', 'd', 'e']);
  });

  it('clamps insertion targets to the remaining-page boundaries', () => {
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'd'], -10)), ['b', 'd', 'a', 'c', 'e']);
    assert.deepEqual(ids(reorderPageBlock(pages, ['b', 'd'], 99)), ['a', 'c', 'e', 'b', 'd']);
  });

  it('returns unchanged order when no pages or all pages are moving', () => {
    assert.deepEqual(ids(reorderPageBlock(pages, [], 2)), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(ids(reorderPageBlock(pages, ['a', 'b', 'c', 'd', 'e'], 2)), ['a', 'b', 'c', 'd', 'e']);
  });

  it('does not mutate the input array', () => {
    const original = pages.map(page => ({ ...page }));
    const result = reorderPageBlock(pages, ['b', 'd'], 2);
    assert.deepEqual(pages, original);
    assert.notEqual(result, pages);
  });
});
