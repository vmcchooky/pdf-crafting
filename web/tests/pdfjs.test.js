/**
 * Node tests for the pdf.js upgrade (S5, CVE-2024-4367).
 * Run: node --test web/tests/
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

describe('pdf.js upgrade (S5)', () => {
  it('mọi getDocument trong app.js đều dùng PDFJS_OPTIONS (isEvalSupported: false)', () => {
    assert.match(appJs, /const PDFJS_OPTIONS = \{ isEvalSupported: false \};/);
    const calls = appJs.split('\n').filter(
      (l) => l.includes('getDocument(') && !l.trim().startsWith('//'),
    );
    assert.ok(calls.length >= 3, `tìm thấy ${calls.length} getDocument, muốn >= 3`);
    for (const line of calls) {
      assert.ok(
        line.includes('PDFJS_OPTIONS'),
        `getDocument thiếu PDFJS_OPTIONS: ${line.trim()}`,
      );
    }
  });

  it('index.html nạp pdf.js ESM 4.x qua loader riêng, không còn UMD 3.x (S15)', () => {
    assert.ok(indexHtml.includes('src="pdfjs-loader.mjs"'), 'index.html phải nạp pdfjs-loader.mjs');
    assert.ok(!indexHtml.includes('vendor/pdf.min.js'), 'index.html còn tham chiếu vendor/pdf.min.js cũ');
    assert.ok(!indexHtml.includes('vendor/pdf.worker.min.js'), 'còn tham chiếu worker .js cũ');
    // Không còn inline <script> (CSP script-src 'self' chặn) — bỏ comment HTML trước khi quét.
    const noComments = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
    for (const line of noComments.split('\n')) {
      assert.ok(!(line.includes('<script') && !line.includes('src=')), `còn inline <script>: ${line.trim()}`);
    }
    const loader = fs.readFileSync(path.join(ROOT, 'pdfjs-loader.mjs'), 'utf8');
    assert.ok(loader.includes("from './vendor/pdf.min.mjs'"), 'pdfjs-loader.mjs phải import vendor/pdf.min.mjs');
    assert.ok(loader.includes('window.pdfjsLib'), 'pdfjs-loader.mjs phải gán window.pdfjsLib');
  });

  it('workerSrc trong app.js trỏ tới worker .mjs cùng version', () => {
    assert.match(appJs, /workerSrc = 'vendor\/pdf\.worker\.min\.mjs'/);
  });

  it('vendor pdf.js >= 4.2.67, export đủ API, worker cùng version', async () => {
    const pdfjsLib = await import('../vendor/pdf.min.mjs');
    assert.equal(typeof pdfjsLib.getDocument, 'function');
    assert.ok(
      pdfjsLib.PDFDateString && typeof pdfjsLib.PDFDateString.toDateObject === 'function',
      'thiếu export PDFDateString',
    );
    const v = parseVersion(pdfjsLib.version);
    assert.ok(v, `không parse được version: ${pdfjsLib.version}`);
    assert.ok(gte(v, [4, 2, 67]), `pdfjsLib.version = ${pdfjsLib.version}, muốn >= 4.2.67`);
    const workerSrc = fs.readFileSync(path.join(ROOT, 'vendor', 'pdf.worker.min.mjs'), 'utf8');
    assert.ok(workerSrc.includes(pdfjsLib.version), 'worker không cùng version với main build');
  });

  it('mở được PDF mẫu với isEvalSupported: false (worker Node)', async () => {
    const pdfjsLib = await import('../vendor/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'vendor', 'pdf.worker.min.mjs');
    const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'sample.pdf')));
    const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
      assert.equal(doc.numPages, 3);
      const page = await doc.getPage(1);
      const text = await page.getTextContent();
      assert.ok(text.items.length > 0, 'trang 1 phải có text');
    } finally {
      await doc.destroy();
    }
  });
});
