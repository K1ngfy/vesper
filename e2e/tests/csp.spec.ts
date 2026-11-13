/**
 * Trusted Types / 严格 CSP 站点回归（对应 v0.2.1 修复的"网页里粘不进去"）。
 *
 * 背景：ChatGPT、Claude 等主流 AI 站点启用
 * `require-trusted-types-for 'script'`，content script 把字符串赋给
 * innerHTML 会抛 TrustedHTML 错误。旧实现用 innerHTML 拼预览弹窗，
 * 异常在 preventDefault 之后抛出 → 用户文本被拦下却无处回填，
 * 表现为"按 Cmd+V 毫无反应"。
 *
 * 本用例即守住这条红线：注入 UI 一律不得使用 innerHTML。
 * 注意：该页面会拒绝 addScriptTag 注入脚本（同样是 TT 限制），
 * 因此内容脚本用 addInitScript 走 CDP 注入（与浏览器原生注入行为一致）。
 */
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const CONTENT_JS = fileURLToPath(
  new URL('../../.output/chrome-mv3/content-scripts/content.js', import.meta.url),
);
const FIXTURE = new URL('../fixtures/csp-tt.html', import.meta.url).pathname;

function makeState(mode: 'auto' | 'preview') {
  return {
    status: 'enabled',
    site: { id: 'site1', host: 'example.com', schemeId: 'sch1', enabled: true, mode },
    scheme: {
      id: 'sch1',
      name: '测试方案',
      isDefault: true,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      rules: [
        {
          id: 'r1',
          type: 'keyword',
          enabled: true,
          name: '机密词',
          pattern: '星辰科技',
          replacement: '公司A',
          mode: 'fixed',
        },
      ],
    },
  };
}

async function setup(page: import('@playwright/test').Page, mode: 'auto' | 'preview') {
  await page.addInitScript((state) => {
    const w = window as unknown as { chrome: unknown; __vesperState: unknown };
    w.__vesperState = state;
    w.chrome = {
      runtime: {
        id: 'vesper-test',
        sendMessage: (msg: { type?: string }) =>
          Promise.resolve(msg?.type === 'GET_SITE_STATE' ? w.__vesperState : undefined),
      },
      storage: { onChanged: { addListener: () => {} } },
    };
  }, makeState(mode));
  await page.addInitScript({ path: CONTENT_JS });
  await page.goto(`file://${FIXTURE}`);
  await page.waitForTimeout(300);
}

/** 真实剪贴板 + 快捷键粘贴（合成事件测不出 CSP 差异） */
async function realPaste(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
  selector: string,
  text: string,
) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator(selector).click();
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('ControlOrMeta+V');
  await page.waitForTimeout(400);
}

test.describe('Trusted Types 站点（innerHTML 被禁）', () => {
  test('preview：弹窗正常显示，确认后回填', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setup(page, 'preview');
    await realPaste(page, context, '#ce', '联系星辰科技');
    await expect(page.getByText(/检测到 1 处敏感信息/)).toBeVisible();
    await page.locator('[data-act="confirm"]').click();
    await expect(page.locator('#ce')).toHaveText('联系公司A');
    expect(errors).toEqual([]);
  });

  test('auto：Toast 正常显示，textarea 被替换', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setup(page, 'auto');
    await realPaste(page, context, '#ta', '星辰科技项目');
    await expect(page.locator('#ta')).toHaveValue('公司A项目');
    await expect(page.getByText(/VESPER 已脱敏 1 处/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
