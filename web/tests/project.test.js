/**
 * Node tests for project validation (S4/S16) in web/utils.js.
 * Run: node --test web/tests/
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateProjectPayload, sanitizeDocMeta, isValidDataUrl, isProjectFileTooLarge, PROJECT_LIMITS } = require('../utils.js');

const VALID_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function validProject() {
  return {
    app: 'pdfcraft',
    kind: 'project',
    version: 1,
    docMeta: { title: 'Báo cáo', author: 'Rio' },
    groups: [{ id: 'g_1', name: 'Nhóm A', color: '#ff0000' }],
    sources: [{ name: 'a.pdf', data: 'JVBERi0xLjQK', fileSize: 7 }],
    pages: [{
      source: 0,
      pageIndex: 0,
      title: 'Trang 1',
      rotation: 0,
      isSelected: false,
      groupIds: ['g_1'],
      stamps: [{
        id: 'stamp_1',
        dataUrl: VALID_PNG,
        relX: 0.1, relY: 0.1, relW: 0.28, relH: 0.1,
        rotation: 0, opacity: 1,
      }],
      originalIndex: 0,
    }],
  };
}

describe('validateProjectPayload', () => {
  it('chấp nhận project hợp lệ', () => {
    const r = validateProjectPayload(validProject());
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
    assert.equal(r.docMeta.title, 'Báo cáo');
  });

  it('chấp nhận project tối thiểu (không groups/docMeta)', () => {
    const p = { app: 'pdfcraft', sources: [], pages: [] };
    const r = validateProjectPayload(p);
    assert.equal(r.ok, true, r.errors.join('; '));
  });

  it('reject khi app sai hoặc không phải object', () => {
    assert.equal(validateProjectPayload(null).ok, false);
    assert.equal(validateProjectPayload('x').ok, false);
    assert.equal(validateProjectPayload({ app: 'other', sources: [], pages: [] }).ok, false);
    assert.equal(validateProjectPayload({ sources: [], pages: [] }).ok, false);
  });

  it('reject khi sources/pages không phải mảng', () => {
    assert.equal(validateProjectPayload({ app: 'pdfcraft', sources: {}, pages: [] }).ok, false);
    assert.equal(validateProjectPayload({ app: 'pdfcraft', sources: [], pages: 'x' }).ok, false);
  });

  it('reject base64 nguồn không hợp lệ', () => {
    for (const bad of ['!!!not-base64!!!', 'abc', 'AB', 'JVBERi0xLjQK===', 'a b c']) {
      const p = validProject();
      p.sources[0].data = bad;
      const r = validateProjectPayload(p);
      assert.equal(r.ok, false, `data=${JSON.stringify(bad)} phải bị reject`);
    }
    const p = validProject();
    p.sources[0].data = 'QQ=='; // 'A' — base64 hợp lệ
    assert.equal(validateProjectPayload(p).ok, true);
  });

  it('reject page source ngoài phạm vi và pageIndex âm', () => {
    const p = validProject();
    p.pages[0].source = 1; // chỉ có 1 source (index 0)
    assert.equal(validateProjectPayload(p).ok, false);

    const p2 = validProject();
    p2.pages[0].pageIndex = -1;
    assert.equal(validateProjectPayload(p2).ok, false);

    const p3 = validProject();
    p3.pages[0].pageIndex = 1.5;
    assert.equal(validateProjectPayload(p3).ok, false);
  });

  it('reject rotation không thuộc {0,90,180,270}', () => {
    const p = validProject();
    p.pages[0].rotation = 45;
    assert.equal(validateProjectPayload(p).ok, false);
  });

  it('reject màu nhóm không phải hex #RRGGBB (chặn style injection)', () => {
    for (const bad of ['red', 'javascript:alert(1)', '#GGGGGG', '#fff', 'red; background:url(x)']) {
      const p = validProject();
      p.groups[0].color = bad;
      const r = validateProjectPayload(p);
      assert.equal(r.ok, false, `color=${JSON.stringify(bad)} phải bị reject`);
    }
    const p = validProject();
    p.groups[0].color = '#00FF88';
    assert.equal(validateProjectPayload(p).ok, true);
  });

  it('reject tên nhóm quá dài và id nhóm trùng', () => {
    const p = validProject();
    p.groups[0].name = 'x'.repeat(PROJECT_LIMITS.maxGroupNameLength + 1);
    assert.equal(validateProjectPayload(p).ok, false);

    const p2 = validProject();
    p2.groups.push({ id: 'g_1', name: 'B', color: '#00ff00' });
    const r2 = validateProjectPayload(p2);
    assert.equal(r2.ok, false);
    assert.match(r2.errors.join(' '), /trùng lặp/);
  });

  it('reject groupIds tham chiếu nhóm không tồn tại', () => {
    const p = validProject();
    p.pages[0].groupIds = ['g_999'];
    assert.equal(validateProjectPayload(p).ok, false);
  });

  it('reject giới hạn số lượng (sources/pages/groups/stamps)', () => {
    const p = validProject();
    p.sources = Array.from({ length: PROJECT_LIMITS.maxSources + 1 }, (_, i) => ({ name: `f${i}.pdf`, data: 'QQ==' }));
    assert.equal(validateProjectPayload(p).ok, false);

    const p2 = validProject();
    p2.pages = Array.from({ length: PROJECT_LIMITS.maxPages + 1 }, () => ({ source: 0, pageIndex: 0 }));
    assert.equal(validateProjectPayload(p2).ok, false);

    const p3 = validProject();
    p3.pages[0].stamps = Array.from({ length: PROJECT_LIMITS.maxStampsPerPage + 1 }, (_, i) => ({
      id: `stamp_${i}`, dataUrl: VALID_PNG, relX: 0.1, relY: 0.1, relW: 0.1, relH: 0.1,
    }));
    assert.equal(validateProjectPayload(p3).ok, false);
  });

  it('reject stamp dataUrl độc hại hoặc quá lớn', () => {
    const badUrls = [
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
      'data:image/png;base64,!!!',
      'https://evil.example/x.png',
    ];
    for (const url of badUrls) {
      const p = validProject();
      p.pages[0].stamps[0].dataUrl = url;
      const r = validateProjectPayload(p);
      assert.equal(r.ok, false, `dataUrl=${url.slice(0, 40)} phải bị reject`);
    }
    // Quá 20 MB
    const huge = 'data:image/png;base64,' + 'A'.repeat(PROJECT_LIMITS.maxStampDataUrlBytes);
    const p = validProject();
    p.pages[0].stamps[0].dataUrl = huge;
    assert.equal(validateProjectPayload(p).ok, false);
  });

  it('reject stamp có relX/opacity ngoài [0,1] hoặc id xấu', () => {
    const p = validProject();
    p.pages[0].stamps[0].relX = 1.5;
    assert.equal(validateProjectPayload(p).ok, false);

    const p2 = validProject();
    p2.pages[0].stamps[0].opacity = 2;
    assert.equal(validateProjectPayload(p2).ok, false);

    const p3 = validProject();
    p3.pages[0].stamps[0].id = '"><img src=x onerror=alert(1)>';
    assert.equal(validateProjectPayload(p3).ok, false);
  });

  it('sanitize docMeta: bỏ non-string, cắt 500 ký tự, bỏ key lạ', () => {
    const r = sanitizeDocMeta({
      title: 'x'.repeat(600),
      author: 123,
      subject: '<script>alert(1)</script>',
      evil: 'drop me',
    });
    assert.equal(r.title.length, PROJECT_LIMITS.maxDocMetaLength);
    assert.equal(r.author, '');
    assert.equal(r.subject, '<script>alert(1)</script>'); // giữ nguyên string, render bằng textContent/value
    assert.equal(r.evil, undefined);
    // validateProjectPayload trả docMeta đã sanitize
    const v = validateProjectPayload({ app: 'pdfcraft', sources: [], pages: [], docMeta: { title: 'y'.repeat(700) } });
    assert.equal(v.ok, true);
    assert.equal(v.docMeta.title.length, PROJECT_LIMITS.maxDocMetaLength);
  });
});

describe('isProjectFileTooLarge (S16)', () => {
  it('từ chối file trên 512 MB, chấp nhận đúng 512 MB trở xuống', () => {
    assert.equal(isProjectFileTooLarge(600 * 1024 * 1024), true);
    assert.equal(isProjectFileTooLarge(PROJECT_LIMITS.maxProjectFileBytes + 1), true);
    assert.equal(isProjectFileTooLarge(PROJECT_LIMITS.maxProjectFileBytes), false);
    assert.equal(isProjectFileTooLarge(1024), false);
    assert.equal(isProjectFileTooLarge(undefined), false);
    assert.equal(isProjectFileTooLarge(null), false);
  });
});

describe('isValidDataUrl', () => {
  it('chấp nhận png/jpeg/webp base64', () => {
    assert.equal(isValidDataUrl(VALID_PNG), true);
    assert.equal(isValidDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), true);
    assert.equal(isValidDataUrl('data:image/webp;base64,UklGRg=='), true);
  });

  it('từ chối svg, text/html, javascript:, http(s):', () => {
    assert.equal(isValidDataUrl('data:image/svg+xml;base64,PHN2Zz4='), false);
    assert.equal(isValidDataUrl('data:text/html;base64,SGVsbG8='), false);
    assert.equal(isValidDataUrl('javascript:alert(1)'), false);
    assert.equal(isValidDataUrl('https://example.com/a.png'), false);
    assert.equal(isValidDataUrl(null), false);
    assert.equal(isValidDataUrl(123), false);
  });
});
