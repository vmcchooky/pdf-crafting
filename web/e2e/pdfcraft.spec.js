/**
 * PDF Craft Web UI - E2E tests (Playwright, Chromium).
 * Run: cd web && npx playwright test  (needs: npx playwright install chromium)
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const PDFLib = require('../vendor/pdf-lib.min.js');
const pdfjsLib = require('../vendor/pdf.min.js');
const { unzipSync } = require('fflate');

pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('../vendor/pdf.worker.min.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.pdf');
const ENCRYPTED_FIXTURE = path.join(__dirname, 'fixtures', 'encrypted.pdf');
const ENCRYPTED_PASSWORD = 'e2e-pdfcraft';

async function uploadSample(page) {
  await page.goto('/web/index.html');
  await page.setInputFiles('#fileInput', FIXTURE);
  await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
}

async function uploadFivePageSample(page) {
  const source = await PDFLib.PDFDocument.create();
  for (let index = 0; index < 5; index++) {
    source.addPage([200 + index * 10, 300]);
  }
  await page.goto('/web/index.html');
  await page.setInputFiles('#fileInput', {
    name: 'five-pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
  });
  await expect(page.locator('.page-card')).toHaveCount(5, { timeout: 30000 });
}

function cardIds(page) {
  return page.$$eval('.page-card', cards => cards.map(card => card.dataset.pageId));
}

function selectedCardIds(page) {
  return page.$$eval('.page-card.selected', cards => cards.map(card => card.dataset.pageId));
}

async function expectCardOrder(page, expectedIds) {
  await expect.poll(async () => (await cardIds(page)).join(',')).toBe(expectedIds.join(','));
}

async function expectSelectedCards(page, expectedIds) {
  await expect.poll(async () => (await selectedCardIds(page)).join(',')).toBe(expectedIds.join(','));
}

function cardCheckbox(page, pageId) {
  return page.locator(`.page-card[data-page-id="${pageId}"] .custom-checkbox`);
}

async function dragCard(page, sourceId, targetId, placeBefore) {
  await page.evaluate(({ sourceId, targetId, placeBefore }) => {
    const source = document.querySelector(`.page-card[data-page-id="${sourceId}"]`);
    const target = document.querySelector(`.page-card[data-page-id="${targetId}"]`);
    const rect = target.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    const eventInit = { bubbles: true, cancelable: true, dataTransfer };
    source.dispatchEvent(new DragEvent('dragstart', eventInit));
    target.dispatchEvent(new DragEvent('dragenter', eventInit));
    target.dispatchEvent(new DragEvent('dragover', {
      ...eventInit,
      clientX: placeBefore ? rect.left + 1 : rect.right - 1,
      clientY: rect.top + rect.height / 2,
    }));
    target.dispatchEvent(new DragEvent('drop', {
      ...eventInit,
      clientX: placeBefore ? rect.left + 1 : rect.right - 1,
      clientY: rect.top + rect.height / 2,
    }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
  }, { sourceId, targetId, placeBefore });
}

async function downloadedPageWidths(download) {
  const bytes = new Uint8Array(await fs.promises.readFile(await download.path()));
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const widths = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const view = (await pdf.getPage(index)).view;
    widths.push(Math.round(Math.abs(view[2] - view[0])));
  }
  await pdf.destroy();
  return widths;
}

function icoSizes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return {
      width: view.getUint8(offset) || 256,
      height: view.getUint8(offset + 1) || 256,
    };
  });
}

async function installPausedClock(page) {
  const now = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
}

test.describe('PDF Craft Web UI', () => {
  test('upload PDF shows 3 page cards', async ({ page }) => {
    await uploadSample(page);
    await expect(page.locator('#statPageCount')).toHaveText('3');
    await expect(page.locator('.page-card').first().locator('.custom-checkbox')).toHaveAccessibleName('Chọn trang #1');
  });

  test('rotate card + undo/redo toggle buttons', async ({ page }) => {
    await uploadSample(page);
    const undo = page.locator('#btnUndo');
    const redo = page.locator('#btnRedo');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();

    await page.locator('.page-card').first().locator('[data-action="rotate"]').click();
    await expect(undo).toBeEnabled();

    await undo.click();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();

    await redo.click();
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
  });

  test('search finds accent-insensitive text', async ({ page }) => {
    await uploadSample(page);
    await page.fill('#searchInput', 'alpha');
    await expect(page.locator('#searchCount')).toContainText('kq', { timeout: 30000 });
    await expect(page.locator('.page-card.search-hit')).toHaveCount(1);
  });

  test('export downloads a PDF file', async ({ page }) => {
    await uploadSample(page);
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnExportPdf').click();
    const download = await downloadPromise;
    expect(await download.suggestedFilename()).toMatch(/\.pdf$/i);
  });

  test('export keeps source metadata and applies user overrides', async ({ page }) => {
    const source = await PDFLib.PDFDocument.create();
    source.addPage();
    source.setTitle('Source title');
    source.setAuthor('Office team');
    source.setProducer('Office PDF Exporter');
    source.setCreationDate(new Date('2026-01-02T03:04:05.000Z'));
    source.setModificationDate(new Date('2026-02-03T04:05:06.000Z'));
    const sourceBytes = await source.save();

    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', {
      name: 'metadata-source.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(sourceBytes),
    });
    await expect(page.locator('.page-card')).toHaveCount(1, { timeout: 30000 });

    await page.locator('#btnMetaEdit').click();
    await page.fill('#inputMetaTitle', 'Edited title');
    await page.locator('#btnSaveMeta').click();

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnExportPdf').click();
    const download = await downloadPromise;
    const exportedBytes = new Uint8Array(await fs.promises.readFile(await download.path()));
    const exported = await pdfjsLib.getDocument({ data: exportedBytes }).promise;
    const { info } = await exported.getMetadata();
    expect(info.Title).toBe('Edited title');
    expect(info.Author).toBe('Office team');
    expect(info.Producer).toBe('Office PDF Exporter');
    expect(pdfjsLib.PDFDateString.toDateObject(info.CreationDate).getTime()).toBe(new Date('2026-01-02T03:04:05.000Z').getTime());
    expect(pdfjsLib.PDFDateString.toDateObject(info.ModDate).getTime()).toBe(new Date('2026-02-03T04:05:06.000Z').getTime());
    await exported.destroy();
  });

  test('split all pages downloads one ZIP containing one PDF per page', async ({ page }) => {
    await uploadSample(page);
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnSplitAll').click();
    const download = await downloadPromise;
    expect(await download.suggestedFilename()).toMatch(/_split\.zip$/i);

    const archive = unzipSync(new Uint8Array(await fs.promises.readFile(await download.path())));
    const names = Object.keys(archive).filter(name => name.endsWith('.pdf'));
    expect(names).toHaveLength(3);
    for (const name of names) {
      const pdf = await PDFLib.PDFDocument.load(archive[name]);
      expect(pdf.getPageCount()).toBe(1);
    }
  });

  test('group export downloads one ZIP with a PDF for each non-empty group', async ({ page }) => {
    await uploadSample(page);
    await page.locator('#btnNewGroup').click();
    await page.fill('#inputGroupName', 'Invoices');
    await page.locator('#btnSaveGroup').click();

    await page.locator('#btnSelectAll').click();
    await page.locator('#btnAssignGroup').click();
    await page.locator('#groupChecklist input').check({ force: true });
    await page.locator('#btnConfirmAssignGroup').click();

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnExportGroups').click();
    const download = await downloadPromise;
    expect(await download.suggestedFilename()).toBe('pdfcraft_groups.zip');

    const archive = unzipSync(new Uint8Array(await fs.promises.readFile(await download.path())));
    const names = Object.keys(archive).filter(name => name.endsWith('.pdf'));
    expect(names).toEqual(['01_Invoices.pdf']);
    const groupedPdf = await PDFLib.PDFDocument.load(archive[names[0]]);
    expect(groupedPdf.getPageCount()).toBe(3);
  });

  test('export remaps source bookmarks after page reorder', async ({ page }) => {
    const sourcePdf = await fs.promises.readFile(FIXTURE);
    let submittedBookmarks = null;
    await page.route('**/api/export/finalize', async route => {
      const body = route.request().postDataBuffer().toString('latin1');
      const partStart = body.indexOf('name="bookmarks"');
      expect(partStart).toBeGreaterThanOrEqual(0);
      const jsonStart = body.indexOf('\r\n\r\n', partStart) + 4;
      const jsonEnd = body.indexOf('\r\n--', jsonStart);
      submittedBookmarks = JSON.parse(body.slice(jsonStart, jsonEnd));
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: sourcePdf });
    });

    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', path.join(__dirname, 'fixtures', 'outline.pdf'));
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('.page-card').nth(2).locator('.custom-checkbox').check({ force: true });
    await page.locator('#btnMoveStart').click();

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnExportPdf').click();
    const download = await downloadPromise;
    expect(await download.suggestedFilename()).toMatch(/\.pdf$/i);
    expect(submittedBookmarks).toHaveLength(2);
    expect(submittedBookmarks.some(bookmark => bookmark.page === 1)).toBe(true);
  });

  test('compression defaults to maximum and describes its impact inline', async ({ page }) => {
    await uploadSample(page);
    await page.locator('#btnOpenCompressModal').click();
    await expect(page.locator('#compressModal')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#presetMaxCompress')).toHaveClass(/active/);
    await expect(page.locator('#dpiRange')).toHaveValue('96');
    await expect(page.locator('#qualityRange')).toHaveValue('40');
    await expect(page.locator('#compressImpactSummary')).toContainText('96 DPI');
    await expect(page.locator('#compressImpactSummary')).toContainText('xóa bookmark');

    await page.locator('#advancedCompressDetails summary').click();
    await page.locator('#optRemoveOutlines').uncheck({ force: true });
    await expect(page.locator('#presetMaxCompress')).not.toHaveClass(/active/);
    await expect(page.locator('#compressImpactSummary')).not.toContainText('xóa bookmark');
  });

  test('compression defaults to color and max preset does not force grayscale', async ({ page }) => {
    await uploadSample(page);
    await page.locator('#btnOpenCompressModal').click();
    await expect(page.locator('#compressModal')).toHaveClass(/active/);
    const grayscale = page.locator('#optGrayscale');
    await expect(grayscale).not.toBeChecked();

    await page.locator('#presetMaxCompress').click();
    await expect(grayscale).not.toBeChecked();
    await expect(page.locator('#compressImpactSummary')).not.toContainText('thang xám');

    await page.locator('#advancedCompressDetails summary').click();
    await grayscale.check({ force: true });
    await expect(page.locator('#compressImpactSummary')).toContainText('thang xám');
  });

  test('modal traps focus, closes with Escape, and restores focus', async ({ page }) => {
    await uploadSample(page);
    const opener = page.locator('#btnOpenCompressModal');
    await opener.click();
    const dialog = page.locator('#compressModal');
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);

    await dialog.evaluate(el => {
      const controls = Array.from(el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      controls.filter(control => control.getClientRects().length > 0).at(-1).focus();
    });
    await page.keyboard.press('Tab');
    await expect.poll(() => dialog.locator(':focus').count()).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toHaveClass(/active/);
    await expect(opener).toBeFocused();
  });

  test('metadata modal saves values', async ({ page }) => {
    await uploadSample(page);
    await page.locator('#btnMetaEdit').click();
    await expect(page.locator('#metaModal')).toHaveClass(/active/);
    await page.fill('#inputMetaTitle', 'E2E Title');
    await page.locator('#btnSaveMeta').click();
    await expect(page.locator('#metaModal')).not.toHaveClass(/active/);
    await expect(page.locator('#btnMetaEdit')).toHaveClass(/btn-accent/);
  });

  test('drag-drop reorder (delegation) changes order + undo restores', async ({ page }) => {
    await uploadSample(page);
    const cards = page.locator('.page-card');
    const firstIdBefore = await cards.first().getAttribute('data-page-id');
    await page.evaluate(() => {
      const els = document.querySelectorAll('.page-card');
      const dt = new DataTransfer();
      els[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      els[1].dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      els[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: 100000, dataTransfer: dt }));
      els[1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 100000, dataTransfer: dt }));
      els[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#btnUndo')).toBeEnabled();
    expect(await cards.first().getAttribute('data-page-id')).not.toBe(firstIdBefore);
    await page.locator('#btnUndo').click();
    expect(await cards.first().getAttribute('data-page-id')).toBe(firstIdBefore);
  });

  test('encrypted PDF prompts password, rejects wrong one, unlocks with correct one', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', ENCRYPTED_FIXTURE);
    await expect(page.locator('#passwordModal')).toHaveClass(/active/);

    await page.fill('#passwordInput', 'sai-mat-khau');
    await page.locator('#btnUnlockPdf').click();
    await expect(page.locator('#passwordError')).toBeVisible();

    await page.fill('#passwordInput', ENCRYPTED_PASSWORD);
    await page.locator('#btnUnlockPdf').click();
    await expect(page.locator('.page-card')).toHaveCount(2, { timeout: 30000 });
  });

  test('encrypted PDF can be skipped when password cancelled', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', ENCRYPTED_FIXTURE);
    await expect(page.locator('#passwordModal')).toHaveClass(/active/);
    await page.locator('#btnCancelPasswordModal').click();
    await expect(page.locator('#passwordModal')).not.toHaveClass(/active/);
    await expect(page.locator('.page-card')).toHaveCount(0);
  });

  test('office convert rejects non-office file client-side', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#convertFileInput', path.join(__dirname, 'fixtures', 'invalid.txt'));
    await expect(page.locator('#toast')).toHaveClass(/toast-danger/);
  });

  test('office convert shows clear error when backend cannot convert', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#convertFileInput', path.join(__dirname, 'fixtures', 'invalid.docx'));
    await expect(page.locator('#toast')).toHaveClass(/toast-danger/, { timeout: 90000 });
  });

  test('outline modal lists bookmarks and jumps to page', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', path.join(__dirname, 'fixtures', 'outline.pdf'));
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOutline').click();
    await expect(page.locator('#outlineModal')).toHaveClass(/active/);
    await expect(page.locator('.outline-item')).toHaveCount(2);
    await page.locator('.outline-item').nth(1).click();
    await expect(page.locator('#previewModal')).toHaveClass(/active/);
    await expect(page.locator('#modalPageNumBadge')).toHaveText('#3');
  });

  test('large view scales the page preview to fill its card frame', async ({ page }) => {
    await uploadSample(page);
    await page.click('#btnViewLarge');
    const wrapper = page.locator('.page-card').first().locator('.card-thumbnail-wrapper');
    const canvas = wrapper.locator('canvas');
    await expect(canvas).toHaveCSS('opacity', '1', { timeout: 20000 });
    const wrapBox = await wrapper.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox.height / wrapBox.height).toBeGreaterThan(0.9);
  });

  test('preview zooms with controls and keeps long titles in a card', async ({ page }) => {
    await uploadSample(page);
    await page.locator('.page-card .card-thumbnail-wrapper').first().click();
    await expect(page.locator('#previewModal')).toHaveClass(/active/);

    const longTitle = 'Đơn đề nghị ký kết phụ lục hợp đồng lao động số 068/HDLĐ-TNL 2026';
    await page.fill('#modalTitleInput', longTitle);
    await page.press('#modalTitleInput', 'Enter');
    await expect(page.locator('#modalTitleInput')).toHaveValue(longTitle);
    await expect(page.locator('#modalTitleInput')).toHaveAttribute('title', longTitle);
    await expect(page.locator('.preview-title-card')).toBeVisible();

    const label = page.locator('#previewZoomLabel');
    const sizer = page.locator('#previewCanvasSizer');
    await expect(label).toHaveText('Vừa trang');
    const before = await sizer.evaluate((el) => el.getBoundingClientRect().width);

    await page.click('#previewZoomIn');
    await expect(label).toHaveText('125%');
    const after = await sizer.evaluate((el) => el.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before * 1.1);

    await page.click('#previewZoomFit');
    await expect(label).toHaveText('Vừa trang');
    await page.click('#modalClose');
    await expect(page.locator('#previewModal')).not.toHaveClass(/active/);
  });

  test('preview opens without focusing the title and uses one thin focus border', async ({ page }) => {
    await uploadSample(page);
    await page.locator('.page-card .card-thumbnail-wrapper').first().click();
    await expect(page.locator('#previewModal')).toHaveClass(/active/);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id)).not.toBe('modalTitleInput');

    const titleInput = page.locator('#modalTitleInput');
    await titleInput.click();
    await expect(titleInput).toHaveCSS('border-top-color', 'rgb(179, 54, 31)');
    const styles = await page.evaluate(() => {
      const input = document.querySelector('#modalTitleInput');
      const card = document.querySelector('.preview-title-card');
      const is = getComputedStyle(input);
      const cs = getComputedStyle(card);
      return {
        inputBorderWidth: is.borderTopWidth,
        inputBorderColor: is.borderTopColor,
        inputOutlineStyle: is.outlineStyle,
        inputShadow: is.boxShadow,
        cardBorderWidth: cs.borderTopWidth,
        cardBorderColor: cs.borderTopColor,
      };
    });
    expect(styles.inputBorderWidth).toBe('1px');
    expect(styles.inputBorderColor).toBe('rgb(179, 54, 31)');
    expect(styles.inputOutlineStyle).toBe('none');
    expect(styles.inputShadow).toBe('none');
    expect(styles.cardBorderWidth).toBe('1px');
    expect(styles.cardBorderColor).toBe('rgba(0, 0, 0, 0)');
  });

  test('preview rotate button rotates the current page and undo restores', async ({ page }) => {
    await uploadSample(page);
    const dim = page.locator('.page-card').first().locator('.card-dim-tag');
    const before = await dim.innerText();
    await page.locator('.page-card .card-thumbnail-wrapper').first().click();
    await expect(page.locator('#previewModal')).toHaveClass(/active/);

    await page.click('#modalRotatePage');
    await expect(page.locator('#toast')).toContainText('xoay trang');
    await expect(dim).not.toHaveText(before);

    await page.click('#modalClose');
    await page.click('#btnUndo');
    await expect(dim).toHaveText(before);
  });

  test('project save button is visible after upload and downloads JSON', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    await uploadSample(page);
    const saveButton = page.locator('#btnSaveProject');
    await expect(saveButton).toBeVisible();
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await saveButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdfcraft\.json$/);
  });

  test('arrow keys move the selected page even when focus is on its checkbox', async ({ page }) => {
    await uploadSample(page);
    const ids = () => page.$$eval('.page-card', (els) => els.map((el) => el.dataset.pageId));
    const before = await ids();
    const movedCheckbox = page.locator(`.page-card[data-page-id="${before[0]}"] .custom-checkbox`);
    await movedCheckbox.click();
    await expect(movedCheckbox).toBeFocused();
    await expect(page.locator('.page-card').first()).toHaveClass(/selected/);

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await ids()).join(',')).toBe([before[1], before[0], before[2]].join(','));
    await expect(movedCheckbox).toBeFocused();

    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await ids()).join(',')).toBe(before.join(','));
  });

  test('Home and End move the selection to document boundaries', async ({ page }) => {
    await uploadSample(page);
    const ids = () => page.$$eval('.page-card', (els) => els.map((el) => el.dataset.pageId));
    const before = await ids();
    await page.locator('.page-card .custom-checkbox').first().click();

    await page.keyboard.press('End');
    await expect.poll(async () => (await ids()).join(',')).toBe([before[1], before[2], before[0]].join(','));

    await page.keyboard.press('Home');
    await expect.poll(async () => (await ids()).join(',')).toBe(before.join(','));
  });

  test('arrow keys extend a multi-selected block and undo restores it', async ({ page }) => {
    await uploadSample(page);
    const ids = () => page.$$eval('.page-card', (els) => els.map((el) => el.dataset.pageId));
    const before = await ids();
    await page.locator('.page-card .custom-checkbox').nth(0).click();
    await page.locator('.page-card .custom-checkbox').nth(1).click();

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await ids()).join(',')).toBe([before[2], before[0], before[1]].join(','));

    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await ids()).join(',')).toBe(before.join(','));
  });

  test('arrow keys gather non-contiguous pages and undo/redo restores order with selection', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();

    await page.keyboard.press('ArrowRight');
    await expectCardOrder(page, [before[0], before[2], before[1], before[3], before[4]]);
    await expectSelectedCards(page, [before[1], before[3]]);
    await expect(page.locator('.page-card').first().locator('.custom-checkbox')).toHaveAccessibleName('Chọn trang #1');

    await page.keyboard.press('ArrowLeft');
    await expectCardOrder(page, [before[0], before[1], before[3], before[2], before[4]]);
    await expectSelectedCards(page, [before[1], before[3]]);

    await page.keyboard.press('Control+z');
    await expectCardOrder(page, [before[0], before[2], before[1], before[3], before[4]]);
    await expectSelectedCards(page, [before[1], before[3]]);

    await page.keyboard.press('Control+y');
    await expectCardOrder(page, [before[0], before[1], before[3], before[2], before[4]]);
    await expectSelectedCards(page, [before[1], before[3]]);
  });

  test('numeric move inserts the selected block at its exact final start position', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();
    let promptMessage = '';
    page.once('dialog', async dialog => {
      promptMessage = dialog.message();
      await dialog.accept('4');
    });

    await page.locator('#btnMoveToPos').click();
    await expectCardOrder(page, [before[0], before[2], before[4], before[1], before[3]]);
    await expectSelectedCards(page, [before[1], before[3]]);
    expect(promptMessage).toContain('2 trang');
    expect(promptMessage).toContain('1 – 4');
    expect(promptMessage).toContain('vị trí bắt đầu');

    await page.locator('#btnUndo').click();
    await expectCardOrder(page, before);
    await expectSelectedCards(page, [before[1], before[3]]);
  });

  test('multi-selected drag honors before and after targets with one undo step', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();

    await dragCard(page, before[1], before[4], false);
    await expectCardOrder(page, [before[0], before[2], before[4], before[1], before[3]]);
    await expectSelectedCards(page, [before[1], before[3]]);
    await page.locator('#btnUndo').click();
    await expectCardOrder(page, before);
    await expectSelectedCards(page, [before[1], before[3]]);

    await dragCard(page, before[1], before[0], true);
    await expectCardOrder(page, [before[1], before[3], before[0], before[2], before[4]]);
    await expectSelectedCards(page, [before[1], before[3]]);
    await page.locator('#btnUndo').click();
    await expectCardOrder(page, before);
  });

  test('dragging an unselected card moves only that card and preserves the selection', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();

    await dragCard(page, before[4], before[0], true);
    await expectCardOrder(page, [before[4], before[0], before[1], before[2], before[3]]);
    await expectSelectedCards(page, [before[1], before[3]]);
    await page.locator('#btnUndo').click();
    await expectCardOrder(page, before);
    await expectSelectedCards(page, [before[1], before[3]]);
  });

  test('checkbox accessible names track positions after reverse and deletion', async ({ page }) => {
    await uploadSample(page);
    const before = await cardIds(page);
    await page.locator('#btnReverseOrder').click();
    await expectCardOrder(page, [before[2], before[1], before[0]]);
    await expect(cardCheckbox(page, before[2])).toHaveAccessibleName('Chọn trang #1');

    await page.locator(`.page-card[data-page-id="${before[2]}"] [data-action="delete"]`).click();
    await expectCardOrder(page, [before[1], before[0]]);
    await expect(cardCheckbox(page, before[1])).toHaveAccessibleName('Chọn trang #1');
  });

  test('Shift selection follows the anchored page ID after reorder', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[3]).click();
    await cardCheckbox(page, before[1]).click();

    await page.keyboard.press('ArrowRight');
    await expectCardOrder(page, [before[0], before[2], before[1], before[3], before[4]]);
    await cardCheckbox(page, before[4]).click({ modifiers: ['Shift'] });
    await expectSelectedCards(page, [before[1], before[3], before[4]]);

    await page.keyboard.press('ArrowLeft');
    await expectCardOrder(page, [before[0], before[1], before[3], before[4], before[2]]);
    await cardCheckbox(page, before[1]).click({ modifiers: ['Shift'] });
    await expectSelectedCards(page, [before[1], before[3], before[4]]);
  });

  test('deleting the anchored page resets Shift selection even after undo', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await page.locator(`.page-card[data-page-id="${before[1]}"] [data-action="delete"]`).click();
    await expectCardOrder(page, [before[0], before[2], before[3], before[4]]);
    await page.locator('#btnUndo').click();
    await expectCardOrder(page, before);

    await cardCheckbox(page, before[3]).click({ modifiers: ['Shift'] });
    await expectSelectedCards(page, [before[1], before[3]]);
  });

  test('dropping inside the moving selection is a no-op', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();

    await dragCard(page, before[1], before[3], false);
    await expectCardOrder(page, before);
    await expectSelectedCards(page, [before[1], before[3]]);
    await expect(page.locator('#btnUndo')).toBeDisabled();
  });

  test('project save and load preserve moved block order and selection', async ({ page }) => {
    page.on('dialog', dialog => dialog.accept());
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();
    await page.keyboard.press('ArrowRight');
    const movedOrder = [before[0], before[2], before[1], before[3], before[4]];
    await expectCardOrder(page, movedOrder);

    const savePromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnSaveProject').click();
    const save = await savePromise;
    const projectBytes = await fs.promises.readFile(await save.path());
    const project = JSON.parse(projectBytes.toString('utf8'));
    expect(project.app).toBe('pdfcraft');
    expect(Array.isArray(project.sources)).toBe(true);
    expect(project.pages.map(item => item.pageIndex)).toEqual([0, 2, 1, 3, 4]);
    expect(project.pages.map(item => item.isSelected)).toEqual([false, false, true, true, false]);

    await page.setInputFiles('#projectFileInput', {
      name: save.suggestedFilename(),
      mimeType: 'application/json',
      buffer: projectBytes,
    });
    await expect.poll(async () => (await cardIds(page)).join(',')).not.toBe(movedOrder.join(','));
    await expect(page.locator('.page-card')).toHaveCount(5);
    await expect(page.locator('.page-card.selected')).toHaveCount(2);
    await expect(page.locator('.page-card').nth(2)).toHaveClass(/selected/);
    await expect(page.locator('.page-card').nth(3)).toHaveClass(/selected/);

    const exportPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnExportPdf').click();
    expect(await downloadedPageWidths(await exportPromise)).toEqual([200, 220, 210, 230, 240]);
  });

  test('export uses the moved block order', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();
    await page.keyboard.press('ArrowRight');
    await expectCardOrder(page, [before[0], before[2], before[1], before[3], before[4]]);

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#btnExportPdf').click();
    const download = await downloadPromise;
    expect(await downloadedPageWidths(download)).toEqual([200, 220, 210, 230, 240]);
  });

  test('toolbar movement clears an active group filter so the result stays visible', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await page.locator('#btnNewGroup').click();
    await page.fill('#inputGroupName', 'Only B');
    await page.locator('#btnSaveGroup').click();
    await cardCheckbox(page, before[1]).click();
    await page.locator('#btnAssignGroup').click();
    await page.locator('#groupChecklist input').check({ force: true });
    await page.locator('#btnConfirmAssignGroup').click();
    await page.locator('.group-chip').filter({ hasText: 'Only B' }).click();
    await expect(page.locator('.page-card:visible')).toHaveCount(1);
    await expect(cardCheckbox(page, before[1])).toBeChecked();

    await page.locator('#btnMoveEnd').click();
    await expectCardOrder(page, [before[0], before[2], before[3], before[4], before[1]]);
    await expect(page.locator('.page-card:visible')).toHaveCount(5);
    await expect(page.locator('.group-chip.active')).toContainText('Tất cả');
    await expect(page.locator('#btnMoveGroup')).toBeHidden();
  });

  test('reorder controls fit desktop and mobile widths without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[1]).click();
    await cardCheckbox(page, before[3]).click();
    await page.locator('#btnMoveEnd').click();
    await expectCardOrder(page, [before[0], before[2], before[4], before[1], before[3]]);

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ))).toBeLessThanOrEqual(viewport.width);
    }

    await page.locator('#btnMoveLeft').click();
    await expectCardOrder(page, [before[0], before[2], before[1], before[3], before[4]]);
    await expect.poll(() => page.evaluate(() => Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ))).toBeLessThanOrEqual(390);
  });

  test('boundary and all-selected moves do not create history entries', async ({ page }) => {
    await uploadFivePageSample(page);
    const before = await cardIds(page);
    await cardCheckbox(page, before[0]).click();
    await page.keyboard.press('ArrowLeft');
    await expectCardOrder(page, before);
    await expect(page.locator('#btnUndo')).toBeDisabled();

    await page.keyboard.press('Control+a');
    await expectSelectedCards(page, before);
    await page.keyboard.press('ArrowRight');
    await expectCardOrder(page, before);
    await expect(page.locator('#btnUndo')).toBeDisabled();
  });

  test('arrow keys do not move pages while editing a page title', async ({ page }) => {
    await uploadSample(page);
    const ids = () => page.$$eval('.page-card', (els) => els.map((el) => el.dataset.pageId));
    const before = await ids();
    await page.locator('.page-card .custom-checkbox').first().click();
    await page.locator('.card-title-input').first().click();

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await ids()).join(',')).toBe(before.join(','));
  });
});

test.describe('PDF Craft startup identity', () => {
  test('serves the seal-and-paper SVG favicon and multi-size ICO fallback', async ({ page }) => {
    await page.goto('/web/index.html');
    const iconLink = page.locator('link[rel="icon"]');
    await expect(iconLink).toHaveAttribute('href', 'favicon.svg');
    await expect(iconLink).toHaveAttribute('type', 'image/svg+xml');

    const svgResponse = await page.request.get('/web/favicon.svg');
    expect(svgResponse.ok()).toBeTruthy();
    expect(svgResponse.headers()['content-type']).toContain('image/svg+xml');
    const svg = await svgResponse.text();
    expect(svg).toContain('#B3361F');
    expect(svg).toContain('#FFFDF9');

    const icoResponse = await page.request.get('/web/favicon.ico');
    expect(icoResponse.ok()).toBeTruthy();
    expect(icoSizes(await icoResponse.body())).toEqual(expect.arrayContaining([
      { width: 16, height: 16 },
      { width: 32, height: 32 },
      { width: 48, height: 48 },
    ]));
  });

  test('shows the exact greeting after 500 ms without stealing focus and hides it after 6 seconds', async ({ page }) => {
    await installPausedClock(page);
    await page.goto('/web/index.html');
    const greeting = page.locator('#startupGreeting');
    const activeBefore = await page.evaluate(() => document.activeElement?.tagName);

    await expect(greeting).toBeHidden();
    await page.clock.fastForward(499);
    await expect(greeting).toBeHidden();
    await page.clock.fastForward(1);
    await expect(greeting).toBeVisible();
    await expect(greeting).toContainText('Lại cần tới tôi rồi à!');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(activeBefore);

    await page.clock.fastForward(6000);
    await expect(greeting).toBeHidden();
  });

  test('dismisses the greeting on click and when a PDF is opened', async ({ page }) => {
    await installPausedClock(page);
    await page.goto('/web/index.html');
    const greeting = page.locator('#startupGreeting');

    await page.clock.fastForward(500);
    await expect(greeting).toBeVisible();
    await greeting.click();
    await expect(greeting).toBeHidden();

    await page.reload();
    await page.clock.fastForward(500);
    await expect(greeting).toBeVisible();
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(greeting).toBeHidden();
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
  });

  test('does not show the greeting when a modal opens during startup', async ({ page }) => {
    await installPausedClock(page);
    await page.goto('/web/index.html');
    await page.locator('#btnOutline').click();
    await expect(page.locator('#outlineModal')).toHaveClass(/active/);

    await page.clock.fastForward(500);
    await expect(page.locator('#startupGreeting')).toBeHidden();
  });

  test('keeps the greeting inside mobile bounds, honors reduced motion, and supports keyboard dismissal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installPausedClock(page);
    await page.goto('/web/index.html');
    await page.clock.fastForward(500);

    const greeting = page.locator('#startupGreeting');
    await expect(greeting).toBeVisible();
    const box = await greeting.boundingBox();
    const fileButtonBox = await page.locator('label[for="fileInput"]').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(374);
    expect(box.y + box.height).toBeLessThanOrEqual(828);
    expect(box.y + box.height <= fileButtonBox.y || box.y >= fileButtonBox.y + fileButtonBox.height).toBeTruthy();
    expect(await greeting.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    expect(await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ))).toBeLessThanOrEqual(390);

    await page.getByRole('button', { name: 'Ẩn lời chào' }).press('Enter');
    await expect(greeting).toBeHidden();
  });
});
