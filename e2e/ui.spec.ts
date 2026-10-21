import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import jsQR from 'jsqr';

const artifactDirectory = process.env.TEST_ARTIFACTS
  ?? fileURLToPath(new URL('../artifacts/e2e/', import.meta.url));
const PROJECT_HOME = process.env.TEST_PROJECT_HOME || 'https://github.com/ndzy01/lan-link';
const UI_PATH = process.env.TEST_UI_PATH || '/demo/';

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  const target = path.join(artifactDirectory, `${testInfo.project.name}-${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  await testInfo.attach(name, { path: target, contentType: 'image/png' });
}

async function assertViewport(page: Page): Promise<void> {
  const measurements = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    touchAction: getComputedStyle(document.documentElement).touchAction,
    fields: Array.from(document.querySelectorAll('textarea, select, input:not([type="file"])'))
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => ({
        id: element.id, size: parseFloat(getComputedStyle(element).fontSize),
        height: element.getBoundingClientRect().height,
      })),
    scrolling: Array.from(document.querySelectorAll('*'))
      .filter((element) => {
        const style = getComputedStyle(element);
        return /auto|scroll/.test(style.overflowY)
          && element.scrollHeight > element.clientHeight
          && element.getBoundingClientRect().width > 0;
      })
      .map((element) => ({ id: element.id, touchAction: getComputedStyle(element).touchAction })),
  }));
  expect(measurements.touchAction).toBe('manipulation');
  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.width + 1);
  expect(measurements.bodyWidth).toBeLessThanOrEqual(measurements.width + 1);
  for (const field of measurements.fields) {
    expect(field.size, field.id).toBeGreaterThanOrEqual(16);
    expect(field.height, field.id).toBeGreaterThanOrEqual(44);
  }
  for (const scroller of measurements.scrolling) expect(scroller.touchAction, scroller.id).toBe('manipulation');
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`demo renders and creates a decodable QR at ${viewport.width} × ${viewport.height}`, async ({ page }, testInfo) => {
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(message.text());
    });
    await page.setViewportSize(viewport);
    await page.goto(UI_PATH);
    await expect(page.getByRole('heading', { level: 1, name: '局域网联机' })).toBeVisible();
    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewportMeta).toContain('width=device-width');
    expect(viewportMeta).toContain('initial-scale=1');
    await expect(page.getByRole('link', { name: '返回项目主页' })).toHaveAttribute('href', PROJECT_HOME);
    await assertViewport(page);
    await screenshot(page, testInfo, `initial-${viewport.width}`);

    await page.getByRole('button', { name: '创建房间', exact: true }).click();
    const code = page.locator('#pairing-code');
    await expect(code).toBeVisible();
    await page.getByText('查看本机配对文本', { exact: true }).click();
    const payload = await page.getByLabel('本机配对文本', { exact: true }).inputValue();
    expect(payload).toMatch(/^LAN1:/);
    const pixels = await code.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      return { width: image.width, height: image.height, data: Array.from(image.data) };
    });
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    expect(decoded?.data).toBe(payload);
    await page.getByText('使用配对文本', { exact: true }).click();
    const input = page.getByLabel('对方的配对文本', { exact: true });
    await input.fill('not-a-pairing-code');
    await input.focus();
    await assertViewport(page);
    await page.getByRole('button', { name: '使用这段配对文本', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(code).toBeVisible();
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    await input.fill('');
    await screenshot(page, testInfo, `pairing-${viewport.width}`);

    await page.getByRole('button', { name: '取消配对', exact: true }).click();
    await expect(code).toBeHidden();
    await expect(page.getByRole('button', { name: '邀请下一台设备', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '离开房间', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建房间', exact: true })).toBeVisible();
    expect(failures).toEqual([]);
  });
}

test('two demo pages pair by importing each other’s actual QR PNG and exchange messages', async ({ page: host, context }, testInfo) => {
  const guest = await context.newPage();
  const failures: string[] = [];
  for (const page of [host, guest]) {
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(message.text());
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(UI_PATH);
  }

  async function importDisplayedCode(from: Page, into: Page, name: string) {
    await expect(from.locator('#pairing-code')).toBeVisible();
    const dataURL = await from.locator('#pairing-code').evaluate((element) => (
      element as HTMLCanvasElement
    ).toDataURL('image/png'));
    await into.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(dataURL.split(',')[1]!, 'base64'),
    });
  }

  await host.getByRole('button', { name: '创建房间', exact: true }).click();
  await guest.getByRole('button', { name: '加入房间', exact: true }).click();
  await importDisplayedCode(host, guest, 'host-invitation.png');
  await importDisplayedCode(guest, host, 'guest-answer.png');
  for (const page of [host, guest]) {
    await expect(page.locator('#connection-status')).toHaveText('已连接 2 台设备');
    await expect(page.locator('#pairing-section')).toBeHidden();
    await expect(page.getByRole('list', { name: '房间设备' }).locator('li')).toHaveCount(2);
    await assertViewport(page);
  }

  await host.getByLabel('消息内容', { exact: true }).fill('二维码配对成功 🌐');
  await host.getByRole('button', { name: '发送', exact: true }).click();
  await expect(guest.locator('#message-log li')).toContainText('二维码配对成功 🌐');
  await expect(guest.locator('#message-log li')).toContainText('收到');
  await guest.getByLabel('数据格式', { exact: true }).selectOption('binary');
  await guest.getByLabel('消息内容', { exact: true }).fill('ABC');
  await guest.getByRole('button', { name: '发送', exact: true }).click();
  await expect(host.locator('#message-log li').first()).toContainText('收到');
  await expect(host.locator('#message-log li').first()).toContainText('二进制');
  await expect(host.locator('#message-log li').first()).toContainText('41 42 43');
  await screenshot(host, testInfo, 'qr-pair-connected-host');
  await screenshot(guest, testInfo, 'qr-pair-connected-guest');

  host.once('dialog', (dialog) => dialog.accept());
  await host.getByRole('button', { name: '离开房间', exact: true }).click();
  await expect(host.getByRole('button', { name: '创建房间', exact: true })).toBeVisible();
  await expect(guest.locator('#connection-status')).toHaveText('连接已结束');
  await guest.getByRole('button', { name: '重新开始', exact: true }).click();
  await expect(guest.getByRole('button', { name: '加入房间', exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test('a directly opened demo returns to the configured project and can create another room after reentry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(UI_PATH);
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.locator('#pairing-code')).toBeVisible();
  // Isolate the external destination while testing actual navigation and cleanup.
  await page.route(PROJECT_HOME, (route) => route.fulfill({
    contentType: 'text/html', body: '<h1>Project home</h1>',
  }));
  // Return with an invitation pending to exercise page cleanup.
  await page.getByRole('link', { name: '返回项目主页', exact: true }).click();
  await expect(page).toHaveURL(PROJECT_HOME);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Project home');

  await page.goto(UI_PATH);
  await expect(page.locator('#connection-status')).toHaveText('尚未连接');
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.locator('#pairing-code')).toBeVisible();
  await page.getByRole('button', { name: '取消配对', exact: true }).click();
  await page.getByRole('button', { name: '离开房间', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建房间', exact: true })).toBeVisible();
});
