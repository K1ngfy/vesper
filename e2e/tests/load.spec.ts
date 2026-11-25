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

test('已打开的工作台跟随后续脱敏更新还原映射', async ({ extCtx, extensionId }) => {
  const page = await extCtx.newPage();
  await page.goto(`chrome-extension://${extensionId}/workbench.html`);
  const record = (mapping: Record<string, string>) =>
    page.evaluate(
      (mapping) =>
        chrome.runtime.sendMessage({ type: 'RECORD_MAPPING', schemeId: 'test', mapping }),
      mapping,
    );
  await page.getByRole('button', { name: '还原模式' }).click();
  await page.locator('textarea').fill('回复 [EMAIL_1]');
  const result = page.locator('div.whitespace-pre-wrap');

  await record({ '[EMAIL_1]': 'first@example.com' });
  await expect(result).toContainText('回复 first@example.com');
  await record({ '[EMAIL_1]': 'second@example.com' });
  await expect(result).toContainText('回复 second@example.com');
  await record({});
  await expect(page.getByText('暂无可还原的映射')).toBeVisible();
  await expect(result).toContainText('回复 [EMAIL_1]');
});

test('侧边栏采用上下布局，工作台采用左右布局，且脱敏/还原高亮分别为淡蓝色与淡红色', async ({
  extCtx,
  extensionId,
}) => {
  // 1) 工作台：左右布局 + 淡蓝（脱敏）/ 淡红（还原）高亮
  const wbPage = await extCtx.newPage();
  await wbPage.setViewportSize({ width: 1000, height: 700 });
  await wbPage.goto(`chrome-extension://${extensionId}/workbench.html`);

  const wbInBox = (await wbPage.getByTestId('workbench-pane-input').boundingBox())!;
  const wbOutBox = (await wbPage.getByTestId('workbench-pane-output').boundingBox())!;
  expect(wbOutBox.x).toBeGreaterThan(wbInBox.x + wbInBox.width - 4);
  expect(Math.abs(wbInBox.y - wbOutBox.y)).toBeLessThan(4);

  await wbPage.locator('textarea').first().fill('邮箱 zhangsan@acme.com 测试');
  const safeMark = wbPage.locator('mark.vesper-mark-safe').first();
  await expect(safeMark).toBeVisible({ timeout: 5000 });
  const safeBg = await safeMark.evaluate((el) => getComputedStyle(el).backgroundColor);
  // #eff6ff -> rgb(239, 246, 255)（蓝通道显著高于红通道）
  expect(safeBg).toBe('rgb(239, 246, 255)');

  // 2) 侧边栏：上下布局 + 还原模式淡红色高亮
  const spPage = await extCtx.newPage();
  await spPage.setViewportSize({ width: 380, height: 760 });
  await spPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const spInBox = (await spPage.getByTestId('workbench-pane-input').boundingBox())!;
  const spOutBox = (await spPage.getByTestId('workbench-pane-output').boundingBox())!;
  expect(Math.abs(spInBox.x - spOutBox.x)).toBeLessThan(4);
  expect(spOutBox.y).toBeGreaterThan(spInBox.y + spInBox.height - 4);

  // 切到还原模式验证仍为上下布局且高亮为淡红色
  await spPage.getByRole('button', { name: '还原模式' }).click();
  const spResInBox = (await spPage.getByTestId('workbench-pane-input').boundingBox())!;
  const spResOutBox = (await spPage.getByTestId('workbench-pane-output').boundingBox())!;
  expect(Math.abs(spResInBox.x - spResOutBox.x)).toBeLessThan(4);
  expect(spResOutBox.y).toBeGreaterThan(spResInBox.y + spResInBox.height - 4);

  await spPage.locator('textarea').first().fill('回复 [EMAIL_1]');
  const restoreMark = spPage.locator('mark.vesper-mark-restore').first();
  await expect(restoreMark).toBeVisible({ timeout: 3000 });
  await expect(restoreMark).toHaveText('zhangsan@acme.com');
  const restoreBg = await restoreMark.evaluate((el) => getComputedStyle(el).backgroundColor);
  // #fef2f2 -> rgb(254, 242, 242)（红通道显著高于蓝通道）
  expect(restoreBg).toBe('rgb(254, 242, 242)');
  await wbPage.close();
  await spPage.close();
});

test('Popup 点击「侧边栏」在同步用户手势内打开原生侧边栏，且兼容 Arc 挂起/幽灵视图兜底', async ({
  extCtx,
  extensionId,
}) => {
  const sw = extCtx.serviceWorkers()[0]!;

  // 1) Chrome 原生路径：同步手势栈帧内直接调用 sidePanel.open，且可见探活通过后不误弹独立窗口
  const popup1 = await extCtx.newPage();
  await popup1.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup1.getByRole('button', { name: '侧边栏' })).toBeVisible();
  await popup1.waitForTimeout(100);
  await popup1.evaluate(() => {
    const orig = chrome.sidePanel.open.bind(chrome.sidePanel);
    chrome.sidePanel.open = (opts) => {
      if (!navigator.userActivation.isActive) {
        return Promise.reject(new Error('lost user gesture'));
      }
      return orig(opts);
    };
  });
  await popup1.getByRole('button', { name: '侧边栏' }).click();
  await expect
    .poll(async () => {
      const contexts = await sw.evaluate(() =>
        chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }),
      );
      return contexts.length;
    })
    .toBeGreaterThan(0);

  // 2) Arc 识别零延迟路径：当检测到 Arc 标记（--arc-palette-* / vesper:isArc）时，直接拉起独立侧边栏窗口
  await sw.evaluate(() => chrome.storage.local.set({ 'vesper:isArc': true }));
  const popup2 = await extCtx.newPage();
  await popup2.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup2.waitForTimeout(100);
  const arcWindowPromise = extCtx.waitForEvent('page', (p) =>
    p.url().includes('/sidepanel.html?mode=window'),
  );
  await popup2.getByRole('button', { name: '侧边栏' }).click();
  const arcSideWindow = await arcWindowPromise;
  await expect(arcSideWindow.getByText('原文')).toBeVisible();
  await arcSideWindow.close();
  await sw.evaluate(() => chrome.storage.local.remove('vesper:isArc'));

  // 3) 首次未知环境 sidePanel.open 挂起不响应路径：350ms 超时解锁并由后台兜底拉起独立窗口
  // 先禁用原生 sidePanel 以模拟无原生侧边栏视图响应
  await sw.evaluate(() => chrome.sidePanel.setOptions({ enabled: false }));
  const popup3 = await extCtx.newPage();
  await popup3.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup3.waitForTimeout(100);
  await popup3.evaluate(() => {
    // 模拟 Arc 中永不 resolve 的挂起 Promise
    chrome.sidePanel.open = () => new Promise<void>(() => {});
  });
  const hungFallbackPromise = extCtx.waitForEvent('page', (p) =>
    p.url().includes('/sidepanel.html?mode=window'),
  );
  await popup3.getByRole('button', { name: '侧边栏' }).click();
  const hungFallbackPage = await hungFallbackPromise;
  await expect(hungFallbackPage.getByText('原文')).toBeVisible();
  await hungFallbackPage.close();
  await sw.evaluate(() =>
    Promise.all([
      chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }),
      chrome.storage.session.remove(['vesper:nativeSidePanelBroken', 'vesper:fallbackWindowId']),
    ]),
  );
});
