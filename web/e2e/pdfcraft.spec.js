/**
 * PDF Craft Web UI - E2E tests (Playwright, Chromium).
 * Run: cd web && npx playwright test  (needs: npx playwright install chromium)
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.pdf');

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
});
