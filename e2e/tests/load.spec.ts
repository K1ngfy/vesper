/**
 * 扩展加载级 E2E：以 persistent context 加载 .output/chrome-mv3，
 * 验证 SW 启动、Popup/工作台渲染、fixture 端到端脱敏、种子数据就绪。
 *
 * 注意事项（实测踩坑记录）：
 * - 品牌 Chrome 137+ 屏蔽 --load-extension，须用 Playwright 自带 Chromium；
 * - 扩展加载必须用 launchPersistentContext（worker 级 fixture 自管，不走默认 page fixture）；
 * - 扩展后台 SW 的 serviceworker 事件不保证触发，用轮询发现。
 */
import { test as base, expect, chromium, type BrowserContext } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../.output/chrome-mv3');

const test = base.extend<{ extensionId: string }, { extCtx: BrowserContext }>({
  extCtx: [
    async ({}, use) => {
      const ctx = await chromium.launchPersistentContext('', {
        headless: false,
        args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
      });
      await use(ctx);
      await ctx.close();
    },
    { scope: 'worker' },
  ],
  extensionId: async ({ extCtx }, use) => {
    const deadline = Date.now() + 15000;
    let sw = extCtx.serviceWorkers()[0];
    while (!sw && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      sw = extCtx.serviceWorkers()[0];
    }
    if (!sw) throw new Error('扩展后台 SW 未启动（检查扩展是否成功加载）');
    await use(sw.url().split('/')[2] ?? '');
  },
});

test('扩展加载后 SW 启动、Popup 渲染品牌页', async ({ extCtx, extensionId }) => {
  expect(extensionId).toBeTruthy();
  const page = await extCtx.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText('VESPER')).toBeVisible();
  await expect(page.getByText('粘贴之前，先过一遍暮星。')).toBeVisible();
});

test('工作台页渲染双栏布局', async ({ extCtx, extensionId }) => {
  const page = await extCtx.newPage();
  await page.goto(`chrome-extension://${extensionId}/workbench.html`);
  await expect(page.getByText('原文')).toBeVisible();
  await expect(page.getByText('脱敏结果')).toBeVisible();
});

test('核心场景：工作台输入 fixture 文本得到脱敏结果', async ({ extCtx, extensionId }) => {
  const page = await extCtx.newPage();
  await page.goto(`chrome-extension://${extensionId}/workbench.html`);
  const textarea = page.locator('textarea').first();
  await textarea.fill('联系张三（zhangsan@acme-tech.com，13812345678）');

  // 防抖 150ms 后结果区出现占位符
  await expect(page.getByText('[EMAIL_1]')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('[PHONE_1]')).toBeVisible();
});

test('种子数据就绪：默认方案与预置站点已写入', async ({ extCtx, extensionId }) => {
  const page = await extCtx.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // 方案下拉应有"默认方案"选项
  await expect(page.locator('option', { hasText: '默认方案' })).toHaveCount(1);
});

test('还原模式：脱敏产物的占位符可还原回原文', async ({ extCtx, extensionId }) => {
  const page = await extCtx.newPage();
  await page.goto(`chrome-extension://${extensionId}/workbench.html`);
  const textarea = page.locator('textarea').first();
  const result = page.locator('div.whitespace-pre-wrap').first();

  // 1) 脱敏模式：输入带邮箱文本，等待占位符出现在结果区
  await textarea.fill('联系 zhangsan@acme.com 或 zhangsan@acme.com');
  await expect(result).toContainText('[EMAIL_1]', { timeout: 5000 });
  const desens = (await result.innerText()).trim();

  // 2) 切到还原模式，把脱敏产物粘进还原框
  await page.getByRole('button', { name: '还原模式' }).click();
  await page.locator('textarea').first().fill(desens);

  // 3) 还原输出区应包含原文邮箱（同值一致 → 同一占位符还原为同一原值）
  await expect(result).toContainText('zhangsan@acme.com', { timeout: 3000 });
});
