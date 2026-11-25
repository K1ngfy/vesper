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

test('站点拦截：弹窗添加站点入列 + 空域名校验', async ({ extCtx, extensionId }) => {
  const page = await openOptions(extCtx, extensionId);
  await page.getByText('站点拦截').click();

  // 打开「添加站点」弹窗（域名输入框是弹窗唯一标识）
  await page.getByRole('button', { name: '添加站点' }).click();
  const hostInput = page.getByPlaceholder('*.example.com');
  await expect(hostInput).toBeVisible();

  // 空域名点添加：提示且弹窗不关闭
  await page.getByRole('button', { name: '新增', exact: true }).click();
  await expect(page.getByText('请先输入域名，如 chatgpt.com')).toBeVisible();
  await expect(hostInput).toBeVisible();

  // 填合法域名后添加：弹窗关闭、提示成功、列表出现该站点行
  await hostInput.fill('example.com');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  await expect(hostInput).toHaveCount(0);
  await expect(page.getByText('已添加站点，请点击其开关启用并授予域名权限')).toBeVisible();
  await expect(page.locator('span.font-mono', { hasText: 'example.com' }).first()).toBeVisible();

  // 重复添加同一域名：弹窗内明确提示重复，且点击遮罩不误关
  await page.getByRole('button', { name: '添加站点' }).click();
  const siteModal = page.getByTestId('add-site-modal');
  await expect(siteModal).toBeVisible();
  await siteModal.getByPlaceholder('*.example.com').fill('example.com');
  await siteModal.getByRole('button', { name: '新增', exact: true }).click();
  await expect(siteModal.getByText('该域名已在列表中，请勿重复添加')).toBeVisible();
  await siteModal.click({ position: { x: 8, y: 8 } });
  await expect(siteModal).toBeVisible();
  await siteModal.getByRole('button', { name: '关闭' }).click();
  await expect(siteModal).toHaveCount(0);
});

test('规则逐条展示、弹窗点击外部不误关、支持编辑已有规则与多行测试预览', async ({
  extCtx,
  extensionId,
}) => {
  const page = await openOptions(extCtx, extensionId);

  // 1) 验证规则为单列逐条排布（各行左对齐、纵坐标严格递增）
  const rows = page.locator('[draggable="true"]');
  const firstBox = (await rows.nth(0).boundingBox())!;
  const secondBox = (await rows.nth(1).boundingBox())!;
  expect(Math.abs(firstBox.x - secondBox.x)).toBeLessThan(2);
  expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height - 2);

  // 2) 新建规则弹窗中框选/点击遮罩边缘不误关闭，已填内容不丢失
  await page.getByText('+ 关键词').click();
  const modal = page.getByTestId('add-rule-modal');
  await expect(modal).toBeVisible();
  const patternInput = modal.getByPlaceholder('精确关键词原文');
  await patternInput.fill('绝密代号');
  await modal.getByPlaceholder(/替换文本/).fill('[CODE]');
  // 点击遮罩左上角边缘
  await modal.click({ position: { x: 8, y: 8 } });
  await expect(modal).toBeVisible();
  await expect(patternInput).toHaveValue('绝密代号');

  // 3) 大尺寸多行测试框实时高亮预览并统计命中数
  const testInput = modal.getByTestId('rule-test-input');
  await testInput.fill('第一行：绝密代号启动\n第二行：确认绝密代号无误');
  const testOutput = modal.getByTestId('rule-test-output');
  await expect(modal.getByText('命中 2 处')).toBeVisible({ timeout: 5000 });
  await expect(testOutput.locator('mark')).toHaveCount(2);
  await expect(testOutput).toContainText('第一行：[CODE]启动');
  await expect(testOutput).toContainText('第二行：确认[CODE]无误');

  await page.getByTestId('confirm-add-rule').click();
  await expect(modal).toHaveCount(0);

  // 4) 先停用刚新建的规则，再点击其「编辑」按钮修改并在弹窗内测试（停用规则也可测试）
  const lastRow = rows.last();
  await lastRow.getByRole('switch').click();
  await expect(lastRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await lastRow.getByRole('button', { name: '编辑' }).click();

  const editModal = page.getByTestId('add-rule-modal');
  await expect(editModal.getByText('编辑规则')).toBeVisible();
  await editModal.getByPlaceholder('规则名称（可选，便于识别）').fill('代号脱敏');
  await editModal.getByPlaceholder(/替换文本/).fill('[SECRET_CODE]');
  await editModal.getByTestId('rule-test-input').fill('测试绝密代号');
  await expect(editModal.getByText('命中 1 处')).toBeVisible({ timeout: 5000 });
  await expect(editModal.getByTestId('rule-test-output')).toContainText('测试[SECRET_CODE]');

  await editModal.getByTestId('confirm-add-rule').click();
  await expect(editModal).toHaveCount(0);
  await expect(lastRow).toContainText('代号脱敏');
  await expect(lastRow).toContainText('[SECRET_CODE]');
});

test('站点拦截：批量绑定方案可正确切回「跟随当前方案」', async ({ extCtx, extensionId }) => {
  const page = await openOptions(extCtx, extensionId);
  await page.getByText('站点拦截').click();

  // 选中第一行站点（*.chatgpt.com），先将其显式绑定到「默认方案」
  const firstSiteRow = page.locator('div.grid', { hasText: '*.chatgpt.com' }).first();
  await firstSiteRow.locator('input[type="checkbox"]').check();
  const batchSchemeSelect = page.getByLabel('绑定方案');
  await expect(batchSchemeSelect).toBeVisible();
  const defaultOptionValue = await batchSchemeSelect
    .locator('option', { hasText: '默认方案' })
    .getAttribute('value');
  await batchSchemeSelect.selectOption(defaultOptionValue!);
  await expect(firstSiteRow.locator('select').first()).toHaveValue(defaultOptionValue!);

  // 再次勾选，批量切回「跟随当前方案」
  await firstSiteRow.locator('input[type="checkbox"]').check();
  await page.getByLabel('绑定方案').selectOption({ label: '跟随当前方案' });
  await expect(firstSiteRow.locator('select').first()).toHaveValue('');
});

test('方案管理：无需打开编辑弹窗即可直接下拉切换规则替换方式', async ({ extCtx, extensionId }) => {
  const page = await openOptions(extCtx, extensionId);
  const emailRow = page.locator('[draggable="true"]', { hasText: '邮箱' }).first();
  const modeSelect = emailRow.getByLabel('替换方式');
  await expect(modeSelect).toHaveValue('numbered');
  await expect(emailRow).toContainText('[EMAIL_n]');

  // 直接在列表行内切换为「固定替换」，摘要同步从 [EMAIL_n] 变为 [EMAIL]
  await modeSelect.selectOption('fixed');
  await expect(modeSelect).toHaveValue('fixed');
  await expect(emailRow).toContainText('[EMAIL]');
  await expect(emailRow).not.toContainText('[EMAIL_n]');

  // 直接切换为「掩码」，摘要同步变为掩码格式，刷新页面后仍持久化生效
  await modeSelect.selectOption('mask');
  await expect(emailRow).toContainText('掩码(留首1·留尾1)');
  await page.reload();
  const reloadedEmailRow = page.locator('[draggable="true"]', { hasText: '邮箱' }).first();
  await expect(reloadedEmailRow.getByLabel('替换方式')).toHaveValue('mask');
});

test('版本更新提示：存在新版本时配置页顶部 Tab 与 Popup 配置入口显示红点', async ({
  extCtx,
  extensionId,
}) => {
  const page = await openOptions(extCtx, extensionId);
  await expect(page.getByTestId('options-update-dot')).toHaveCount(0);

  // 模拟检测到 GitHub Release 新版本 v99.0.0
  await page.evaluate(() =>
    chrome.storage.local.set({
      'vesper:update': {
        checkedAt: Date.now(),
        latestVersion: '99.0.0',
        releaseUrl: 'https://github.com/K1ngfy/vesper/releases/tag/v99.0.0',
      },
    }),
  );

  // 配置页顶部「设置与数据」Tab 实时出现红点，点进可见下载横幅
  await expect(page.getByTestId('options-update-dot')).toBeVisible();
  await page.getByRole('button', { name: /设置与数据/ }).click();
  await expect(page.getByTestId('update-available-banner')).toContainText('发现新版本 v99.0.0');

  // Popup「配置」入口同步显示红点
  const popup = await extCtx.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByTestId('popup-update-dot')).toBeVisible();

  // 当远端版本不高于当前版本时，红点自动熄灭
  await page.evaluate(() =>
    chrome.storage.local.set({
      'vesper:update': {
        checkedAt: Date.now(),
        latestVersion: '0.0.1',
      },
    }),
  );
  await expect(page.getByTestId('options-update-dot')).toHaveCount(0);
  await expect(popup.getByTestId('popup-update-dot')).toHaveCount(0);
});

test('全局模式：例外站点修改时保存按钮变黑，点击保存落盘后变灰', async ({
  extCtx,
  extensionId,
}) => {
  const page = await openOptions(extCtx, extensionId);
  await page.evaluate(async () => {
    const res = await chrome.storage.local.get('vesper:settings');
    const current = res['vesper:settings'] as Record<string, unknown>;
    await chrome.storage.local.set({
      'vesper:settings': { ...current, siteScope: 'global' },
    });
  });
  await page.getByText('站点拦截').click();

  const textarea = page.getByTestId('exclude-hosts-textarea');
  const saveBtn = page.getByTestId('save-exclude-hosts');
  await expect(textarea).toBeVisible();

  const readBgRgb = () =>
    saveBtn.evaluate((el) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    });

  // 初始已保存态：按钮禁用且为灰色（bg-neutral-200）
  await expect(saveBtn).toBeDisabled();
  await expect(saveBtn).toHaveClass(/bg-neutral-200/);
  await expect.poll(async () => (await readBgRgb())[0]).toBeGreaterThan(200);

  // 编辑例外站点后：未保存状态按钮启用且过渡为纯黑（bg-black -> [0, 0, 0]），尚未落库
  const initialValue = await textarea.inputValue();
  await textarea.fill(`${initialValue}\ninternal.corp.example`);
  await expect(saveBtn).toBeEnabled();
  await expect(saveBtn).toHaveClass(/bg-black/);
  await expect.poll(readBgRgb).toEqual([0, 0, 0]);
  const beforeSave = await page.evaluate(async () => {
    const res = await chrome.storage.local.get('vesper:settings');
    return (res['vesper:settings'] as { excludeHosts: string[] }).excludeHosts;
  });
  expect(beforeSave).not.toContain('internal.corp.example');

  // 点击保存后：配置落库，按钮恢复灰色禁用状态，并展示「已保存」提示
  await saveBtn.click();
  await expect(saveBtn).toBeDisabled();
  await expect(saveBtn).toHaveClass(/bg-neutral-200/);
  await expect.poll(async () => (await readBgRgb())[0]).toBeGreaterThan(200);
  await expect(page.getByText('已保存')).toBeVisible();

  const afterSave = await page.evaluate(async () => {
    const res = await chrome.storage.local.get('vesper:settings');
    return (res['vesper:settings'] as { excludeHosts: string[] }).excludeHosts;
  });
  expect(afterSave).toContain('internal.corp.example');
});

test('全局模式未授权时使用红色文字展示相关授权提示信息', async ({ extCtx, extensionId }) => {
  const page = await openOptions(extCtx, extensionId);
  await page.getByText('站点拦截').click();

  const readTextRgb = (locator: import('@playwright/test').Locator) =>
    locator.evaluate((el) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    });

  // 1) 默认未授予 *://*/* 时，「全局模式」卡片内显示红色未授权提示
  const needGrant = page.getByTestId('global-need-grant');
  await expect(needGrant).toBeVisible();
  await expect(needGrant).toContainText('尚未授权「访问所有网站」，点击本卡片完成授权');
  const cardRgb = await readTextRgb(needGrant);
  expect(cardRgb[0]).toBeGreaterThan(180);
  expect(cardRgb[1]).toBeLessThan(70);
  expect(cardRgb[2]).toBeLessThan(70);

  // 2) 点击「全局模式」但拒绝权限时，页面顶部也用红色文字提示未完成授权
  await page.evaluate(() => {
    chrome.permissions.request = () => Promise.resolve(false);
  });
  await page.getByRole('button', { name: /全局模式/ }).click();
  const notice = page.getByTestId('sites-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('尚未授予「访问所有网站」权限');
  const noticeRgb = await readTextRgb(notice);
  expect(noticeRgb[0]).toBeGreaterThan(180);
  expect(noticeRgb[1]).toBeLessThan(70);
  expect(noticeRgb[2]).toBeLessThan(70);
});
