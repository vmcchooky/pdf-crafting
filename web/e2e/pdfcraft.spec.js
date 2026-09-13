/**
 * PDF Craft Web UI - E2E tests (Playwright, Chromium).
 * Run: cd web && npx playwright test  (needs: npx playwright install chromium)
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.pdf');
const ENCRYPTED_FIXTURE = path.join(__dirname, 'fixtures', 'encrypted.pdf');
const ENCRYPTED_PASSWORD = 'e2e-pdfcraft';

async function uploadSample(page) {
  await page.goto('/web/index.html');
  await page.setInputFiles('#fileInput', FIXTURE);
  await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
}

test.describe('PDF Craft Web UI', () => {
  test('upload PDF shows 3 page cards', async ({ page }) => {
    await uploadSample(page);
    await expect(page.locator('#statPageCount')).toHaveText('3');
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
});
