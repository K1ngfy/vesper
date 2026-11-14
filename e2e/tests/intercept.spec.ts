/**
 * 粘贴拦截全链路自动复现（文档 4.6 / 第 9 节矩阵的自动化子集）。
 *
 * 方法：注入【真实构建产物】.output/chrome-mv3/content-scripts/content.js，
 * 用 addInitScript 预置 chrome.runtime.sendMessage 桩（返回指定站点状态与方案），
 * 再用真实剪贴板与快捷键触发粘贴。可覆盖：
 * textarea 自动替换 / contenteditable 预览确认 / 无命中放行 / 密码框永不拦截。
 * （chrome.scripting 注册与权限授予属浏览器原生 UI，仍需手工验收。）
 */
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const CONTENT_JS = fileURLToPath(
  new URL('../../.output/chrome-mv3/content-scripts/content.js', import.meta.url),
);
const FIXTURE = new URL('../fixtures/intercept-test.html', import.meta.url).pathname;

/** 测试方案：keyword 机密词 + builtin email（numbered） */
function makeSiteState(mode: 'auto' | 'preview' | 'warn-only') {
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
  workerAvailable: boolean | 'deferred' = false,
) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(
    ({ state, workerAvailable }) => {
      // chrome API 桩：GET_SITE_STATE 返回可变状态；onChanged 监听器可被测试触发
      const w = window as unknown as {
        chrome: unknown;
        __vesperState: unknown;
        __vesperListeners: ((changes: unknown, area: string) => void)[];
        __finishRedaction?: (succeeded: boolean) => void;
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
            if (msg?.type === 'ENSURE_ENGINE') {
              if (workerAvailable === 'deferred') {
                return new Promise<boolean>((resolve) => {
                  w.__finishRedaction = resolve;
                });
              }
              return Promise.resolve(workerAvailable);
            }
            return Promise.resolve(undefined);
          },
          connect: () => {
            let receive: (response: unknown) => void;
            return {
              disconnect() {},
              onDisconnect: { addListener() {} },
              onMessage: {
                addListener(fn: typeof receive) {
                  receive = fn;
                },
              },
              postMessage({ text }: { text: string }) {
                const original = '星辰科技';
                const replaced = '公司A';
                queueMicrotask(() =>
                  receive({
                    output: text.replace(original, replaced),
                    hits: [{ ruleName: '机密词', original, replaced }],
                    mapping: {},
                  }),
                );
              },
            };
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
    },
    { state: makeSiteState(mode), workerAvailable },
  );
  await page.goto(`file://${FIXTURE}`);
  // 注入真实构建产物
  await page.addScriptTag({ path: CONTENT_JS });
  await page.waitForTimeout(200); // 等 init 异步完成、监听挂载
}

async function pasteInto(page: import('@playwright/test').Page, selector: string, text: string) {
  await page.locator(selector).focus();
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press('ControlOrMeta+V');
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

  test('长预览只滚动列表，命中统计和按钮保持在原位', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await setup(page, 'preview');
    const original = '星辰科技 '.repeat(60).trim();
    await pasteInto(page, '#ta', original);
    const dialog = page.getByRole('dialog', { name: '粘贴预览' });
    const list = dialog.getByRole('region', { name: '脱敏预览列表' });
    const summary = dialog.getByText(/共 60 处，仅展示前 50 条/);
    const footerItems = [
      summary,
      ...['取消', '粘贴原文', '脱敏粘贴'].map((name) => dialog.getByRole('button', { name })),
    ];
    for (const item of footerItems) await expect(item).toBeInViewport({ ratio: 1 });
    const initial = await Promise.all(footerItems.map((item) => item.boundingBox()));

    await list.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await Promise.all(footerItems.map((item) => item.boundingBox()))).toEqual(initial);
    expect(await dialog.evaluate((el) => el.scrollTop)).toBe(0);

    await dialog.getByRole('button', { name: '脱敏粘贴' }).click();
    await expect(page.locator('#ta')).toHaveValue(original.replaceAll('星辰科技', '公司A'));
  });

  test('无命中：完全放行，无 Toast 无弹窗', async ({ page }) => {
    await setup(page, 'auto');
    await pasteInto(page, '#ta', '今天天气不错');
    await expect(page.locator('#ta')).toHaveValue('今天天气不错');
    await expect(page.locator('#vesper-shadow-host')).toHaveCount(0);
  });

  test('密码框：永不拦截', async ({ page }) => {
    await setup(page, 'auto');
    await pasteInto(page, '#pw', '星辰科技');
    await expect(page.locator('#pw')).toHaveValue('星辰科技');
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

test.describe('富文本分批回填', () => {
  // Split around emoji and line breaks while preserving indentation and blank lines.
  const original =
    '星辰科技' +
    'x'.repeat(4092) +
    '😀\n' +
    ('  中文草稿\t字  符  '.repeat(3) + '\n\n').repeat(400) +
    '结束\n';
  const redacted = original.replace('星辰科技', '公司A');

  test('预览确认一次后完整回填，保留选区两侧草稿并在批次之间让出主线程', async ({ page }) => {
    await setup(page, 'preview', true);
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      el.textContent = '开头替换结尾';
      el.focus();
      const selection = window.getSelection()!;
      selection.setBaseAndExtent(el.firstChild!, 2, el.firstChild!, 4);
      let yielded = false;
      el.addEventListener('input', () => {
        if (yielded) el.setAttribute('data-yielded', 'true');
        setTimeout(() => {
          yielded = true;
        }, 0);
      });
    });
    await pasteInto(page, '#ce', original);
    await expect(editor).toHaveText('开头替换结尾');
    await page.locator('[data-act="confirm"]').click();
    await expect(page.getByText(/VESPER 已脱敏 1 处/)).toBeVisible({ timeout: 15000 });
    await expect(editor).toHaveAttribute('data-yielded', 'true');
    expect(await editor.innerText()).toBe('开头' + redacted + '结尾');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
  });

  test('回填途中焦点移开时只复制尚未插入的部分', async ({ page }) => {
    await setup(page, 'auto', true);
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      el.addEventListener(
        'input',
        () => {
          setTimeout(() => document.querySelector<HTMLTextAreaElement>('#ta')!.focus(), 0);
        },
        { once: true },
      );
    });
    await pasteInto(page, '#ce', original);
    await expect(page.getByText(/粘贴中断，已复制尚未插入的部分/)).toBeVisible();
    const inserted = await editor.innerText();
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.length).toBeLessThan(redacted.length);
    expect(inserted + (await page.evaluate(() => navigator.clipboard.readText()))).toBe(redacted);
    await expect(page.locator('#ta')).toHaveValue('');
  });

  test('编辑器在微任务中重建节点并恢复光标后继续回填', async ({ page }) => {
    await setup(page, 'auto', true);
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      let pending = false;
      el.addEventListener('input', () => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          const selection = getSelection()!;
          const anchor = selection.anchorNode;
          if (!anchor || !el.contains(anchor)) return;
          const offset = selection.anchorOffset;
          if (anchor === el) {
            const previous = el.childNodes[offset - 1];
            if (previous) el.replaceChild(previous.cloneNode(true), previous);
            selection.collapse(el, offset);
          } else {
            const replacement = anchor.cloneNode(true);
            anchor.parentNode!.replaceChild(replacement, anchor);
            selection.collapse(replacement, offset);
          }
          el.setAttribute('data-rebuilt', 'true');
        });
      });
    });
    await pasteInto(page, '#ce', original);
    await expect(page.getByText(/VESPER 已脱敏 1 处/)).toBeVisible({ timeout: 15000 });
    await expect(editor).toHaveAttribute('data-rebuilt', 'true');
    expect(await editor.innerText()).toBe(redacted);
  });

  test('ProseMirror 风格的编辑器接收保留空行和缩进的脱敏粘贴内容', async ({ page }) => {
    await setup(page, 'auto');
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      el.classList.add('ProseMirror');
      el.addEventListener('paste', (event) => {
        event.preventDefault();
        const html = (event as ClipboardEvent).clipboardData?.getData('text/html') ?? '';
        const document = new DOMParser().parseFromString(html, 'text/html');
        const paragraphs = [...document.querySelectorAll('[data-pm-slice] > p')];
        el.textContent = paragraphs.map((paragraph) => paragraph.textContent).join('\n');
      });
    });
    await pasteInto(page, '#ce', '星辰科技\n\n  <标签>\t内容  \n');
    await expect(page.getByText(/VESPER 已脱敏 1 处/)).toBeVisible();
    expect(await editor.textContent()).toBe('公司A\n\n  <标签>\t内容  \n');
  });
});

test.describe('扩展 Worker 不可用', () => {
  const large = 'a@x.com '.repeat(8 * 1024);

  test('自动替换：Worker 失败时不回填未脱敏内容', async ({ page }) => {
    await setup(page, 'auto');
    await page.locator('#ta').fill('原有草稿');
    await pasteInto(page, '#ta', large);
    await expect(page.getByText(/已阻止粘贴/)).toBeVisible();
    await expect(page.locator('#ta')).toHaveValue('原有草稿');
  });

  test('预览确认：Worker 失败时不回填未脱敏内容', async ({ page }) => {
    await setup(page, 'preview');
    await pasteInto(page, '#ce', large);
    await expect(page.getByText(/已阻止粘贴/)).toBeVisible();
    await expect(page.locator('#ce')).toHaveText('');
  });
});

test.describe('大文本脱敏动画', () => {
  const large = '星辰科技' + '样本文本'.repeat(4000);
  const busy = (page: import('@playwright/test').Page) =>
    page.getByRole('dialog', { name: '正在脱敏，请稍候…' });

  async function finishRedaction(page: import('@playwright/test').Page, succeeded: boolean) {
    await page.evaluate((ok) => {
      (window as unknown as { __finishRedaction: (success: boolean) => void }).__finishRedaction(
        ok,
      );
    }, succeeded);
  }

  test('Worker 立即返回时，动画也会持续显示一小段时间', async ({ page }) => {
    await setup(page, 'preview', true);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1_000));
    await pasteInto(page, '#ta', large);
    await page.clock.runFor(150);
    await expect(busy(page)).toBeVisible();
    await expect(page.getByRole('dialog', { name: '粘贴预览' })).toHaveCount(0);
    await page.clock.runFor(300);
    await expect(busy(page)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '粘贴预览' })).toBeVisible();
  });

  test('处理时屏蔽点击、输入和 Escape，完成后显示预览', async ({ page }) => {
    await setup(page, 'preview', 'deferred');
    const field = page.locator('#ta');
    await field.fill('原有草稿');
    const box = (await field.boundingBox())!;
    await pasteInto(page, '#ta', large);
    const dialog = busy(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.spinner')).toHaveCSS('animation-name', 'spin');
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.keyboard.press('Escape');
    await page.keyboard.type('ignored');
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue('原有草稿');
    await finishRedaction(page, true);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '粘贴预览' })).toBeVisible();
  });

  test('处理失败时关闭动画，恢复页面输入', async ({ page }) => {
    await setup(page, 'auto', 'deferred');
    await pasteInto(page, '#ta', large);
    await expect(busy(page)).toBeVisible();
    await finishRedaction(page, false);
    await expect(busy(page)).toHaveCount(0);
    await expect(page.getByText(/已阻止粘贴/)).toBeVisible();
    const field = page.locator('#ta');
    await expect(field).toHaveValue('');
    await field.fill('可以继续输入');
    await expect(field).toHaveValue('可以继续输入');
  });

  test('Worker 启动超时后自动解锁，迟到的响应不会回填', async ({ page }) => {
    await setup(page, 'auto', 'deferred');
    await page.clock.install();
    await pasteInto(page, '#ta', large);
    await expect(busy(page)).toBeVisible();
    await page.clock.fastForward(12_000);
    await expect(busy(page)).toHaveCount(0);
    await expect(page.getByText(/已阻止粘贴/)).toBeVisible();
    await finishRedaction(page, true);
    await expect(page.locator('#ta')).toHaveValue('');
  });
});
