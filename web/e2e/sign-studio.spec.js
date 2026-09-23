/**
 * Smoke: open redesigned Sign Studio, switch rails, place type signature, save.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.pdf');

test.describe('Sign Studio redesign', () => {
  test('open, switch rails, place typed signature, save', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });

    await page.locator('#btnOpenSignStudio').click();
    await expect(page.locator('#signModal')).toHaveClass(/active/);

    // Vertical rail present
    await expect(page.locator('.sign-rail')).toBeVisible();
    await expect(page.locator('#tabUpload')).toHaveClass(/active/);

    // Switch to type tab
    await page.locator('#tabType').click();
    await expect(page.locator('#tabType')).toHaveClass(/active/);
    await expect(page.locator('#paneType')).toBeVisible();
    await expect(page.locator('#paneUpload')).toBeHidden();

    // Type a name and place
    await page.fill('#signTypeName', 'Tran Van Test');
    await page.locator('#btnPlaceStampOnPage').click();
    await expect(page.locator('.stamp-box')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#signStampCountBadge')).toContainText('1');

    // Official tab switch
    await page.locator('#tabOfficial').click();
    await expect(page.locator('#paneOfficial')).toBeVisible();
    await expect(page.locator('#officialStampBox')).toBeVisible();

    // Save
    await page.locator('#btnSaveSignDone').click();
    await expect(page.locator('#signModal')).not.toHaveClass(/active/);

    // Badge on page card
    await expect(page.locator('.card-signed-badge').first()).toBeVisible();
  });

  test('library place uses selected card not always first', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });

    // Seed two library items via localStorage
    await page.evaluate(() => {
      const tiny = (color) => {
        const c = document.createElement('canvas');
        c.width = 40; c.height = 20;
        const ctx = c.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 40, 20);
        return c.toDataURL('image/png');
      };
      localStorage.setItem('pdfcraft_stamp_library', JSON.stringify([
        { id: 'lib_a', name: 'Dau A', dataUrl: tiny('#ff0000'), createdAt: Date.now() },
        { id: 'lib_b', name: 'Dau B', dataUrl: tiny('#0000ff'), createdAt: Date.now() },
      ]));
    });

    await page.locator('#btnOpenSignStudio').click();
    await expect(page.locator('#signModal')).toHaveClass(/active/);
    await expect(page.locator('.stamp-lib-card')).toHaveCount(2);

    // First card auto-selected; pick second card then place
    await page.locator('.stamp-lib-card').nth(1).locator('.stamp-lib-title').click();
    await expect(page.locator('.stamp-lib-card').nth(1)).toHaveClass(/selected/);
    await page.locator('#btnPlaceStampOnPage').click();
    await expect(page.locator('.stamp-box')).toHaveCount(1, { timeout: 10000 });

    // Placed stamp image should match lib_b (blue), not lib_a
    const src = await page.locator('.stamp-box-img').first().getAttribute('src');
    const list = await page.evaluate(() => JSON.parse(localStorage.getItem('pdfcraft_stamp_library')));
    expect(src).toBe(list[1].dataUrl);
  });
});
