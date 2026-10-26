/**
 * 粘贴拦截全链路自动复现（文档 4.6 / 第 9 节矩阵的自动化子集）。
 *
 * 方法：注入【真实构建产物】.output/chrome-mv3/content-scripts/content.js，
 * 用 addInitScript 预置 chrome.runtime.sendMessage 桩（返回指定站点状态与方案），
 * 再以合成 ClipboardEvent 模拟用户粘贴。可覆盖：
 * textarea 自动替换 / contenteditable 预览确认 / 无命中放行 / 密码框永不拦截。
 * （chrome.scripting 注册与权限授予属浏览器原生 UI，仍需手工验收。）
 */
import { test, expect } from '@playwright/test';

const CONTENT_JS = '../.output/chrome-mv3/content-scripts/content.js';
const FIXTURE = new URL('../fixtures/intercept-test.html', import.meta.url).pathname;

/** 测试方案：keyword 机密词 + builtin email（numbered） */
function makeSiteState(mode: 'auto' | 'preview' | 'warn-only') {
  return {
    status: 'enabled',
    site: { id: 'site1', matchPattern: '*://example.com/*', schemeId: 'sch1', enabled: true, mode },
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
        {
          id: 'r2',
          type: 'builtin',
          enabled: true,
          name: '邮箱',
          pattern: 'email',
          replacement: '[EMAIL_n]',
          mode: 'numbered',
        },
      ],
    },
  };
}

async function setup(
  page: import('@playwright/test').Page,
  mode: 'auto' | 'preview' | 'warn-only',
) {
  await page.addInitScript((state) => {
    // chrome API 桩：GET_SITE_STATE 返回可变状态；onChanged 监听器可被测试触发
    const w = window as unknown as {
      chrome: unknown;
      __vesperState: unknown;
      __vesperListeners: ((changes: unknown, area: string) => void)[];
    };
    w.__vesperState = state;
    w.__vesperListeners = [];
    w.chrome = {
      runtime: {
        id: 'vesper-test',
        sendMessage: (msg: { type?: string }) => {
          if (msg?.type === 'GET_SITE_STATE') return Promise.resolve(w.__vesperState);
          if (msg?.type === 'INCREMENT_COUNT') return Promise.resolve(1);
          if (msg?.type === 'RECORD_MAPPING') return Promise.resolve(undefined);
          return Promise.resolve(undefined);
        },
      },
      storage: {
        onChanged: {
          addListener: (fn: (changes: unknown, area: string) => void) => {
            w.__vesperListeners.push(fn);
          },
        },
      },
    };
  }, makeSiteState(mode));
  await page.goto(`file://${FIXTURE}`);
  // 注入真实构建产物
  await page.addScriptTag({ path: CONTENT_JS });
  await page.waitForTimeout(200); // 等 init 异步完成、监听挂载
}

/** 合成 paste 事件（Chromium 的 ClipboardEvent 构造器不接受 clipboardData 时走兜底） */
async function pasteInto(page: import('@playwright/test').Page, selector: string, text: string) {
  await page.evaluate(
    ({ sel, text }) => {
      const target = document.querySelector(sel)! as HTMLElement;
      target.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      let ev: Event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      if (!(ev as ClipboardEvent).clipboardData) {
        ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      target.dispatchEvent(ev);
    },
    { sel: selector, text },
  );
}

test.describe('粘贴拦截全链路（真实构建产物 + chrome API 桩）', () => {
  test('auto 模式：textarea 粘贴关键字被替换 + Toast 出现', async ({ page }) => {
    await setup(page, 'auto');
    await pasteInto(page, '#ta', '星辰科技的项目 zhangsan@acme.com 结束');
    await expect(page.locator('#ta')).toHaveValue('公司A的项目 [EMAIL_1] 结束');
    // Toast（Shadow DOM，Playwright 可穿透 open shadow root）
    await expect(page.getByText(/VESPER 已脱敏 2 处/)).toBeVisible();
  });

  test('preview 模式：contenteditable 弹预览，确认后回填', async ({ page }) => {
    await setup(page, 'preview');
    await pasteInto(page, '#ce', '联系星辰科技HR zhangsan@acme.com');
    // 预览弹窗出现（命中 2 处）
    await expect(page.getByText(/检测到 2 处敏感信息/)).toBeVisible();
    await page.locator('[data-act="confirm"]').click();
    await expect(page.locator('#ce')).toHaveText('联系公司AHR [EMAIL_1]');
  });

  test('preview 模式：取消则不回填任何内容', async ({ page }) => {
    await setup(page, 'preview');
    await pasteInto(page, '#ce', '星辰科技机密');
    await expect(page.getByText(/检测到 1 处敏感信息/)).toBeVisible();
    await page.locator('[data-act="cancel"]').click();
    await expect(page.locator('#ce')).toHaveText('');
  });

  test('无命中：完全放行，无 Toast 无弹窗', async ({ page }) => {
    await setup(page, 'auto');
    await pasteInto(page, '#ta', '今天天气不错');
    // 合成事件不走浏览器默认插入，值保持空 = 未被 preventDefault 拦截改写
    await expect(page.locator('#ta')).toHaveValue('');
    await expect(page.locator('#vesper-shadow-host')).toHaveCount(0);
  });

  test('密码框：永不拦截', async ({ page }) => {
    await setup(page, 'auto');
    await pasteInto(page, '#pw', '星辰科技');
    await expect(page.locator('#pw')).toHaveValue('');
    await expect(page.locator('#vesper-shadow-host')).toHaveCount(0);
  });

  test('同值一致：同一邮箱多处粘贴使用同一编号（跨两次粘贴重新编号属正常）', async ({ page }) => {
    await setup(page, 'auto');
    await pasteInto(page, '#ta', 'a@x.com 与 a@x.com');
    await expect(page.locator('#ta')).toHaveValue('[EMAIL_1] 与 [EMAIL_1]');
  });

  test('回归：页面打开后切换方案，无需刷新即按新方案拦截', async ({ page }) => {
    await setup(page, 'auto');
    await pasteInto(page, '#ta', '星辰科技');
    await expect(page.locator('#ta')).toHaveValue('公司A');

    // 模拟用户在 Popup 切换到 Work 方案（同一关键字，替换为"公司B"）
    await page.evaluate((baseState) => {
      const w = window as unknown as {
        __vesperState: typeof baseState;
        __vesperListeners: ((changes: unknown, area: string) => void)[];
      };
      const next = JSON.parse(JSON.stringify(baseState)) as typeof baseState;
      next.scheme.id = 'sch_work';
      next.scheme.name = 'Work';
      next.scheme.rules[0]!.replacement = '公司B';
      w.__vesperState = next;
      for (const fn of w.__vesperListeners) fn({ 'vesper:settings': {} }, 'local');
    }, makeSiteState('auto'));
    await page.waitForTimeout(300); // 等 refreshCtx 完成

    await page.locator('#ta').fill('');
    await pasteInto(page, '#ta', '星辰科技');
    await expect(page.locator('#ta')).toHaveValue('公司B');
  });
});
