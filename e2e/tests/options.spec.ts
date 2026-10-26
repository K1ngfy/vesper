/**
 * 配置页"添加规则"弹窗 + 规则快速筛选的 E2E（真实扩展 options 页）。
 * 验收点：
 * - 点击 + 关键词 → 弹窗出现，确认前规则不入列；
 * - 校验：不填内容点新增 → 显示错误、不关闭；
 * - 填写后确认 → 弹窗关闭、卡片出现在列表；
 * - 筛选芯片：按类型过滤 + 计数正确。
 */
import { test as base, expect, chromium, type BrowserContext } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../.output/chrome-mv3');

// 配置页会修改 storage，故每测试用独立 persistent context（隔离存储，避免互相污染）
const test = base.extend<{ extCtx: BrowserContext; extensionId: string }>({
  extCtx: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext('', {
      headless: false,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    await use(ctx);
    await ctx.close();
  },
  extensionId: async ({ extCtx }, use) => {
    const deadline = Date.now() + 15000;
    let sw = extCtx.serviceWorkers()[0];
    while (!sw && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      sw = extCtx.serviceWorkers()[0];
    }
    if (!sw) throw new Error('扩展后台 SW 未启动');
    await use(sw.url().split('/')[2] ?? '');
  },
});

async function openOptions(extCtx: BrowserContext, extensionId: string) {
  const page = await extCtx.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // 等 SchemesTab 异步加载完成（默认方案名出现在输入框里）
  await expect(page.locator('input', { hasText: '' }).first()).toBeVisible();
  await expect(page.getByText('默认方案')).toBeVisible();
  return page;
}

test('添加规则走弹窗：空内容报错、填写后确认入列', async ({ extCtx, extensionId }) => {
  const page = await openOptions(extCtx, extensionId);
  const initialCount = await page.locator('[draggable="true"]').count();

  // 点击 + 关键词 → 弹窗出现
  await page.getByText('+ 关键词').click();
  const modal = page.getByTestId('add-rule-modal');
  await expect(modal).toBeVisible();
  const confirm = page.getByTestId('confirm-add-rule');

  // 直接点新增：报错且弹窗不关闭
  await confirm.click();
  await expect(modal.getByText('请先填写匹配内容（关键词或正则）')).toBeVisible();
  await expect(modal).toBeVisible();

  // 填写关键字与替换文本后确认：弹窗关闭，规则卡片 +1（在弹窗内定位，避免命中背后卡片）
  await modal.getByPlaceholder('精确关键词原文').fill('星辰科技');
  await modal.getByPlaceholder(/替换文本/).fill('公司A');
  await confirm.click();
  await expect(modal).toHaveCount(0); // 弹窗关闭
  await expect(page.locator('[draggable="true"]')).toHaveCount(initialCount + 1);
  // 用"全部"筛选芯片的计数自增来断言新规则已落库（比定位输入值更稳健）
  await expect(page.getByText(/^全部 · \d+$/)).toHaveText(new RegExp(`全部 · ${initialCount + 1}`));
});

test('快速筛选：按类型过滤且计数正确', async ({ extCtx, extensionId }) => {
  const page = await openOptions(extCtx, extensionId);

  // 默认方案含内置规则；关键词筛选应为空态
  await page.getByText(/^关键词 · \d+$/).click();
  await expect(page.getByText('当前筛选下没有规则')).toBeVisible();

  // 内置筛选：卡片数与芯片计数一致（默认方案 12 条内置规则）
  const chip = page.getByText(/^内置 · (\d+)$/);
  const count = (await chip.textContent())!.match(/(\d+)$/)![1];
  await chip.click();
  await expect(page.locator('[draggable="true"]')).toHaveCount(Number(count));

  // 全部：恢复
  await page.getByText(/^全部 · \d+$/).click();
  await expect(page.locator('[draggable="true"]')).toHaveCount(Number(count));
});

test('站点拦截：输入合法模式后添加站点入列；空输入按钮禁用', async ({ extCtx, extensionId }) => {
  const page = await openOptions(extCtx, extensionId);
  await page.getByText('站点拦截').click();

  // 空输入时按钮禁用（cursor-not-allowed）
  const addBtn = page.getByRole('button', { name: '添加站点' });
  await expect(addBtn).toHaveClass(/cursor-not-allowed/);

  // 输入合法模式 + 回车 → 新站点行出现
  const input = page.getByPlaceholder('匹配模式，如 *://chatgpt.com/*');
  await input.fill('*://example.com/*');
  await input.press('Enter');
  // 新站点行的名称与模式两处都会显示该串，取首个即可
  await expect(page.getByText('*://example.com/*').first()).toBeVisible();
  // 添加后输入框清空、按钮恢复禁用（预期行为）
  await expect(addBtn).toHaveClass(/cursor-not-allowed/);
});
