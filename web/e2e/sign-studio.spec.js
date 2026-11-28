/**
 * Smoke: open redesigned Sign Studio, switch rails, place type signature, save.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const PDFLib = require('../vendor/pdf-lib.min.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.pdf');

async function seedStampLibrary(page) {
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
}

async function countPngColorPixels(page, dataUrl, rgb) {
  return page.evaluate(async ({ dataUrl, rgb }) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] && pixels[i] === rgb[0] && pixels[i + 1] === rgb[1] && pixels[i + 2] === rgb[2]) count++;
    }
    return count;
  }, { dataUrl, rgb });
}

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

    // Place disabled when library empty & name empty
    await expect(page.locator('#signStampCountBadge')).toContainText('0');
    await expect(page.locator('#btnPlaceStampOnPage')).toBeDisabled();

    // Switch to type tab
    await page.locator('#tabType').click();
    await expect(page.locator('#tabType')).toHaveClass(/active/);
    await expect(page.locator('#tabType')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tabType')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#tabUpload')).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('#paneType')).toBeVisible();
    await expect(page.locator('#paneUpload')).toBeHidden();

    // Type a name and place
    await page.fill('#signTypeName', 'Tran Van Test');
    await expect(page.locator('#btnPlaceStampOnPage')).toBeEnabled();
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

  test('sign studio does not request network fonts', async ({ page }) => {
    const fontRequests = [];
    page.on('request', request => {
      const hostname = new URL(request.url()).hostname;
      if (hostname === 'fonts.googleapis.com' || hostname === 'fonts.gstatic.com') fontRequests.push(request.url());
    });
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOpenSignStudio').click();
    await expect(page.locator('#signModal')).toHaveClass(/active/);
    await page.locator('#tabType').click();
    await expect(page.locator('#paneType')).toBeVisible();
    expect(fontRequests).toEqual([]);
  });

  test('official stamp supports square border, radius slider and lean presets', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOpenSignStudio').click();
    await page.locator('#tabOfficial').click();
    await expect(page.locator('#paneOfficial')).toBeVisible();

    await expect(page.locator('#paneOfficial .btn-preset-chip')).toHaveCount(4);
    const box = page.locator('#officialStampBox');
    await expect(box).toHaveCSS('border-radius', '0px');
    await expect(page.locator('#rngOfficialRadius')).toHaveValue('0');

    await page.locator('#rngOfficialRadius').evaluate((el) => {
      el.value = '12';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(box).toHaveCSS('border-radius', '12px');

    await page.selectOption('#stampBorderType', 'none');
    await expect(box).toHaveCSS('border-top-style', 'none');
    await expect(page.locator('#rngOfficialRadius')).toBeDisabled();

    await page.selectOption('#stampBorderType', 'single');
    await expect(box).toHaveCSS('border-radius', '12px');
    await expect(page.locator('#rngOfficialRadius')).toBeEnabled();
  });

  test('one-line official preset must generate a one-line stamp image', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOpenSignStudio').click();
    await page.locator('#tabOfficial').click();
    await expect(page.locator('#paneOfficial')).toBeVisible();

    // Dấu tên 1 dòng: dòng chức danh bị ẩn thì ảnh sinh ra cũng không được có dòng đó.
    await page.locator('#paneOfficial [data-preset="name_only"]').click();
    await expect(page.locator('#previewOfficialTitle')).toBeHidden();
    await page.fill('#stampOfficialName', 'GIÁM ĐỐC');
    await page.locator('#btnPlaceStampOnPage').click();
    await expect(page.locator('.stamp-box')).toHaveCount(1);

    // Mẫu 2 dòng dùng đúng chất liệu chữ của mẫu 1 dòng để so sánh chiều cao ảnh.
    await page.locator('#paneOfficial [data-preset="title_name"]').click();
    await page.fill('#stampOfficialTitle', 'GIÁM ĐỐC');
    await page.fill('#stampOfficialName', 'NGUYỄN VĂN AN');
    await page.locator('#btnPlaceStampOnPage').click();
    await expect(page.locator('.stamp-box')).toHaveCount(2);

    const dims = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll('.stamp-box-img')];
      await Promise.all(imgs.map(img => (img.complete ? null : new Promise(resolve => {
        img.onload = resolve;
        img.onerror = resolve;
      }))));
      return imgs.map(img => ({ w: img.naturalWidth, h: img.naturalHeight }));
    });
    expect(dims).toHaveLength(2);
    expect(dims[0].h).toBeLessThan(dims[1].h);
  });

  test('official stamp tilt keeps the full rotated corners', async ({ page }) => {
    await page.goto('/web/index.html');
    const dims = await page.evaluate(async () => {
      const url = window.generateOfficialStampDataUrl({
        title: '',
        name: 'GIÁM ĐỐC',
        borderType: 'single',
        color: '#c81e1e',
        hasGrunge: false,
        angle: 3,
      });
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      return { w: img.naturalWidth, h: img.naturalHeight };
    });
    // 360x88 nghiêng 3° cần canvas ~364x107 (x2 DPR); nếu crop theo canvas cũ
    // thì góc trên/dưới bị cắt và ảnh chỉ còn ~720x176.
    expect(dims.h).toBeGreaterThan(190);
    expect(dims.w / dims.h).toBeLessThan(3.8);
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

  test('drag a library stamp onto the page at the drop position', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await seedStampLibrary(page);

    await page.locator('#btnOpenSignStudio').click();
    await expect(page.locator('#signModal')).toHaveClass(/active/);
    await expect(page.locator('.stamp-lib-card')).toHaveCount(2);

    const stage = page.locator('#signStageCanvas');
    await expect(stage).toBeVisible();
    const canvasBox = await stage.boundingBox();
    await page.locator('.stamp-lib-card').first().dragTo(stage, {
      targetPosition: { x: Math.round(canvasBox.width * 0.25), y: Math.round(canvasBox.height * 0.4) },
    });
    await expect(page.locator('.stamp-box')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#signStampCountBadge')).toContainText('1');
    const left = await page.locator('.stamp-box').first().evaluate((el) => parseFloat(el.style.left));
    expect(left).toBeLessThan(50);
  });

  test('write tools add shape, text and pen stroke with opacity and layering', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });

    await page.locator('#btnOpenSignStudio').click();
    await expect(page.locator('#signModal')).toHaveClass(/active/);
    await page.click('#tabWrite');
    await expect(page.locator('#paneWrite')).toBeVisible();

    await page.click('#btnAddShape');
    await expect(page.locator('.stamp-box')).toHaveCount(1);
    const shapeSrc = await page.locator('.stamp-box-img').first().getAttribute('src');
    expect(shapeSrc.startsWith('data:image/png')).toBeTruthy();

    await page.click('#toolText');
    await page.fill('#writeTextInput', 'Xin chào PDFCraft');
    await page.click('#btnAddText');
    await expect(page.locator('.stamp-box')).toHaveCount(2);

    await page.click('#toolPen');
    const drawCanvas = page.locator('#signDrawCanvas');
    const box = await drawCanvas.boundingBox();
    await page.mouse.move(box.x + 50, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 140, { steps: 6 });
    await page.mouse.move(box.x + 210, box.y + 100, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.stamp-box')).toHaveCount(3, { timeout: 10000 });

    await page.click('#toolShape');
    await page.locator('.sign-stamp-item').last().click();
    await page.locator('#signOpacity').evaluate((el) => {
      el.value = '60';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const opacity = await page.locator('.stamp-box.active').first().evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeCloseTo(0.6, 1);

    await page.locator('.sign-stamp-item').first().click();
    const shapeImg = page.locator('.stamp-box-img').first();
    const srcBefore = await shapeImg.getAttribute('src');
    await page.click('#shapeColorPicker summary');
    await page.click('#shapeColorPicker [data-write-color="#b3361f"]');
    await expect.poll(async () => shapeImg.getAttribute('src')).not.toBe(srcBefore);
    const idsBefore = await page.$$eval('.stamp-box', (els) => els.map((el) => el.dataset.stampId));
    await page.click('#btnFloatForward');
    const idsAfter = await page.$$eval('.stamp-box', (els) => els.map((el) => el.dataset.stampId));
    expect(idsAfter[1]).toBe(idsBefore[0]);

    await page.click('#btnSaveSignDone');
    await expect(page.locator('#signModal')).not.toHaveClass(/active/);
    await expect(page.locator('.card-signed-badge').first()).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.click('#btnExportPdf');
    const download = await downloadPromise;
    const exportedBytes = new Uint8Array(await fs.promises.readFile(await download.path()));
    const exported = await PDFLib.PDFDocument.load(exportedBytes);
    const resources = exported.getPage(0).node.Resources();
    let xObjectCount = 0;
    if (resources) {
      const xObjects = resources.lookup(PDFLib.PDFName.of('XObject'));
      if (xObjects && typeof xObjects.keys === 'function') xObjectCount = xObjects.keys().length;
    }
    expect(xObjectCount).toBeGreaterThan(0);
  });

  test('pen palette offers common colors and draws the selected ink', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOpenSignStudio').click();
    await page.click('#tabWrite');
    await page.click('#toolPen');

    const picker = page.locator('#penColorPicker');
    await expect(picker.locator('[data-pen-color]')).toHaveCount(24);
    await picker.locator('summary').click();
    await picker.locator('summary').focus();
    await page.keyboard.press('Tab');
    const selected = picker.locator('[data-pen-color][aria-pressed="true"]');
    await expect(selected).toBeFocused();
    await expect(selected).toHaveCSS('outline-color', 'rgb(26, 28, 26)');
    await expect(selected).toHaveCSS('outline-width', '2px');
    const blue = picker.locator('[data-pen-color="#2563eb"]');
    await blue.focus();
    await page.keyboard.press('Enter');
    await expect(blue).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.locator('summary')).toHaveAttribute('aria-label', 'Màu bút: Xanh dương tươi');
    await expect(picker.locator('details')).not.toHaveAttribute('open', '');
    await expect(picker.locator('summary')).toBeFocused();

    const drawCanvas = page.locator('#signDrawCanvas');
    const box = await drawCanvas.boundingBox();
    await page.mouse.move(box.x + 60, box.y + 90);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 150, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.stamp-box')).toHaveCount(1, { timeout: 10000 });
    const src = await page.locator('.stamp-box-img').first().getAttribute('src');
    expect(await countPngColorPixels(page, src, [37, 99, 235])).toBeGreaterThan(0);
  });

  test('shape fill palette offers common colors and fills the selected shape', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOpenSignStudio').click();
    await page.click('#tabWrite');
    await page.locator('#chkShapeFill').check();

    const picker = page.locator('#shapeFillPicker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-fill-color]')).toHaveCount(12);
    await expect(picker.locator('.write-preview-fill')).toHaveCSS('fill-opacity', '1');
    await expect(picker.locator('.write-color-preview')).toHaveCSS('background-color', 'rgb(241, 238, 231)');
    await picker.locator('summary').click();
    const previewIsOpaque = await picker.locator('.write-color-preview').evaluate(element => {
      let current = element;
      while (current) {
        if (getComputedStyle(current).opacity !== '1') return false;
        if (current.id === 'shapeFillPicker') return true;
        current = current.parentElement;
      }
      return false;
    });
    expect(previewIsOpaque).toBe(true);
    const yellow = picker.locator('[data-fill-color="#facc15"]');
    await yellow.click();
    await expect(yellow).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.locator('summary')).toHaveAttribute('aria-label', 'Màu nền: Vàng');

    await page.click('#btnAddShape');
    await expect(page.locator('.stamp-box')).toHaveCount(1);
    const src = await page.locator('.stamp-box-img').first().getAttribute('src');
    expect(await countPngColorPixels(page, src, [250, 204, 21])).toBeGreaterThan(0);
  });

  test('writing controls keep one thin border and one focus color', async ({ page }) => {
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOpenSignStudio').click();
    await page.click('#tabWrite');
    await page.click('#toolText');

    for (const selector of ['#writeTextInput', '#writeFontSelect', '#inputStageZoom']) {
      const control = page.locator(selector);
      const resting = await control.evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: style.borderTopWidth, outline: style.outlineStyle, shadow: style.boxShadow };
      });
      expect(resting.width).toBe('1px');
      expect(resting.outline).toBe('none');
      expect(resting.shadow).toBe('none');

      await control.focus();
      await expect(control).toHaveCSS('border-top-color', 'rgb(179, 54, 31)');
      const focused = await control.evaluate((el) => {
        const style = getComputedStyle(el);
        return { outline: style.outlineStyle, shadow: style.boxShadow };
      });
      expect(focused.outline).toBe('none');
      expect(focused.shadow).toBe('none');
    }
  });

  test('pen palette stays inside the mobile panel without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/web/index.html');
    await page.setInputFiles('#fileInput', FIXTURE);
    await expect(page.locator('.page-card')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#btnOpenSignStudio').click();
    await page.click('#tabWrite');
    await page.click('#toolPen');

    const picker = page.locator('#penColorPicker');
    await picker.locator('summary').click();
    await expect(picker.locator('details')).toBeVisible();
    // CI (Linux) render với font metrics phân số: preview nằm đúng mép fold
    // của panel (scrollHeight 480 > clientHeight 240) và bị cắt ~0.3px dưới
    // đáy vùng nhìn thấy — scroll vào view trước khi đo, assertion lúc này
    // kiểm tra "không bị cắt khi đã trong view" thay vì vị trí fold ngẫu
    // nhiên theo nền tảng.
    await page.evaluate(() =>
      document.querySelector('#penColorPicker .write-color-preview').scrollIntoViewIfNeeded());
    await expect.poll(async () => page.evaluate(() => {
      const panel = document.querySelector('.sign-panel-scroll').getBoundingClientRect();
      const preview = document.querySelector('#penColorPicker .write-color-preview').getBoundingClientRect();
      return preview.top >= panel.top && preview.bottom <= panel.bottom;
    }), {
      // Chẩn đoán CI-only: in rect thô khi predicate không đạt trong 5s.
      message: 'pen palette preview phải nằm trong panel dọc — rect: ' +
        JSON.stringify(await page.evaluate(() => {
          const panel = document.querySelector('.sign-panel-scroll').getBoundingClientRect();
          const preview = document.querySelector('#penColorPicker .write-color-preview').getBoundingClientRect();
          const panelStyle = getComputedStyle(document.querySelector('.sign-panel-scroll'));
          return {
            panel: { top: panel.top, bottom: panel.bottom, height: panel.height },
            preview: { top: preview.top, bottom: preview.bottom, height: preview.height },
            panelScrollHeight: document.querySelector('.sign-panel-scroll').scrollHeight,
            panelClientHeight: document.querySelector('.sign-panel-scroll').clientHeight,
            panelOverflowY: panelStyle.overflowY,
            bodyFontSize: getComputedStyle(document.body).fontSize,
          };
        })),
    }).toBe(true);
    const metrics = await page.evaluate(() => {
      const panel = document.querySelector('.sign-panel-scroll');
      const palette = document.querySelector('#penColorPicker details');
      const grid = document.querySelector('#penColorPicker .write-color-grid');
      const panelRect = panel.getBoundingClientRect();
      const paletteRect = palette.getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        panelClientWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
        gridClientWidth: grid.clientWidth,
        gridScrollWidth: grid.scrollWidth,
        paletteRight: paletteRect.right,
        panelRight: panelRect.right,
      };
    });
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.panelScrollWidth).toBeLessThanOrEqual(metrics.panelClientWidth);
    expect(metrics.gridScrollWidth).toBeLessThanOrEqual(metrics.gridClientWidth);
    expect(metrics.paletteRight).toBeLessThanOrEqual(metrics.panelRight);
  });
});
