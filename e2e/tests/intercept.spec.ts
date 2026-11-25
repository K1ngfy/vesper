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
        __vesperStateReads: number;
        __vesperListeners: ((changes: unknown, area: string) => void)[];
        __finishRedaction?: (succeeded: boolean) => void;
      };
      w.__vesperState = state;
      w.__vesperStateReads = 0;
      w.__vesperListeners = [];
      w.chrome = {
        runtime: {
          id: 'vesper-test',
          sendMessage: (msg: { type?: string }) => {
            if (msg?.type === 'GET_SITE_STATE') {
              w.__vesperStateReads += 1;
              return Promise.resolve(w.__vesperState);
            }
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

async function setSiteState(page: import('@playwright/test').Page, state: unknown, notify = true) {
  await page.evaluate(
    ({ state, notify }) => {
      const w = window as unknown as {
        __vesperState: unknown;
        __vesperListeners: ((changes: unknown, area: string) => void)[];
      };
      w.__vesperState = state;
      if (notify) for (const fn of w.__vesperListeners) fn({ 'vesper:settings': {} }, 'local');
    },
    { state, notify },
  );
}

async function waitForSiteReads(page: import('@playwright/test').Page, count: number) {
  await page.waitForFunction(
    (count) => (window as unknown as { __vesperStateReads: number }).__vesperStateReads >= count,
    count,
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
    const next = makeSiteState('auto');
    next.scheme.id = 'sch_work';
    next.scheme.name = 'Work';
    next.scheme.rules[0]!.replacement = '公司B';
    await setSiteState(page, next);
    await waitForSiteReads(page, 2);

    await page.locator('#ta').fill('');
    await pasteInto(page, '#ta', '星辰科技');
    await expect(page.locator('#ta')).toHaveValue('公司B');
  });

  test('站点状态暂时读取失败后，连续粘贴仍脱敏并自动恢复配置同步', async ({ page }) => {
    await setup(page, 'auto');
    await page.clock.install();
    const field = page.locator('#ta');
    for (const original of ['星辰科技 ', '星辰科技 ']) await pasteInto(page, '#ta', original);
    await expect(field).toHaveValue('公司A 公司A ');

    await setSiteState(page, null);
    await waitForSiteReads(page, 2);
    await pasteInto(page, '#ta', '星辰科技 ');
    await expect(field).toHaveValue('公司A 公司A 公司A ');

    await setSiteState(page, { status: 'disabled' }, false);
    await page.clock.fastForward(1_000);
    await waitForSiteReads(page, 3);
    await pasteInto(page, '#ta', '星辰科技');
    await expect(field).toHaveValue('公司A 公司A 公司A 星辰科技');
  });

  test('重读相同站点配置时既有预览仍可确认', async ({ page }) => {
    await setup(page, 'preview');
    await pasteInto(page, '#ta', '星辰科技');
    const dialog = page.getByRole('dialog', { name: '粘贴预览' });
    await expect(dialog).toBeVisible();
    await setSiteState(page, makeSiteState('preview'));
    await waitForSiteReads(page, 2);
    await dialog.getByRole('button', { name: '脱敏粘贴' }).click();
    await expect(page.locator('#ta')).toHaveValue('公司A');
  });

  test('warn-only 模式：不阻断原生粘贴，保留原文并弹出提醒 Toast', async ({ page }) => {
    await setup(page, 'warn-only');
    await pasteInto(page, '#ta', '星辰科技 zhangsan@acme.com');
    await expect(page.locator('#ta')).toHaveValue('星辰科技 zhangsan@acme.com');
    await expect(page.getByText(/发现 2 处敏感信息，已按"仅提醒"放行原文/)).toBeVisible();
  });

  test('Toast 通知位于右上角，持续显示 10 秒，且支持手动关闭', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await setup(page, 'auto');
    await page.clock.install();

    await pasteInto(page, '#ta', '星辰科技的项目 zhangsan@acme.com 结束');
    const toast = page.locator('#vesper-shadow-host .toast');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-variant', 'success');
    await expect(toast.locator('.toast-bar')).toHaveCount(1);

    // 验证位于视口右上角（而非右下角；计入入场微位移滑入动画余量）
    const box = (await toast.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.y).toBeLessThan(60);
    expect(1000 - (box.x + box.width)).toBeGreaterThanOrEqual(4);
    expect(1000 - (box.x + box.width)).toBeLessThan(50);

    // 7.5 秒时仍保持显示（延长了原 6 秒显示时长），超过 10 秒后自动消失
    await page.clock.fastForward(7_500);
    await expect(toast).toBeVisible();
    await page.clock.fastForward(3_000);
    await expect(toast).toHaveCount(0);

    // 再次触发粘贴，验证点击右上角关闭按钮可立即收起通知
    await page.locator('#ta').fill('');
    await pasteInto(page, '#ta', '星辰科技');
    await expect(toast).toBeVisible();
    await toast.locator('[data-act="dismiss"]').click();
    await expect(toast).toHaveCount(0);
  });

  test('beforeinput 自接管富文本编辑器：回填不误判失败且不污染剪贴板', async ({ page }) => {
    await setup(page, 'auto');
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      el.addEventListener('beforeinput', (e) => {
        const ie = e as InputEvent;
        if (ie.inputType === 'insertText' && ie.data) {
          ie.preventDefault();
          el.textContent = (el.textContent ?? '') + ie.data;
        }
      });
    });
    await pasteInto(page, '#ce', '联系星辰科技\n第二行');
    await expect(editor).toHaveText('联系公司A\n第二行');
    await expect(page.getByText(/VESPER 已脱敏 1 处/)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('联系星辰科技\n第二行');
  });

  test('preview 模式点击「脱敏粘贴」时拦截站点 paste 内的 clipboard.read/readText，不触发浏览器确认弹窗且不泄露原剪贴板', async ({
    page,
  }) => {
    await setup(page, 'preview');
    // 撤销 clipboard-read 授权以还原真实网页默认状态（仅保留测试写入剪贴板所需的 clipboard-write）
    await page.context().clearPermissions();
    await page.context().grantPermissions(['clipboard-write']);

    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      el.addEventListener('paste', async (e) => {
        e.preventDefault();
        const textFromApi = await navigator.clipboard.readText();
        const items = await navigator.clipboard.read();
        const blob = await items[0]!.getType('text/plain');
        const itemText = await blob.text();
        el.setAttribute('data-read-text', textFromApi);
        el.setAttribute('data-read-item', itemText);
        el.textContent = textFromApi;
      });
    });

    await pasteInto(page, '#ce', '星辰科技\n联系 zhangsan@acme.com');
    await expect(page.getByText(/检测到 2 处敏感信息/)).toBeVisible();
    await page.locator('[data-act="confirm"]').click();

    await expect(editor).toHaveText('公司A\n联系 [EMAIL_1]');
    await expect(editor).toHaveAttribute('data-read-text', '公司A\n联系 [EMAIL_1]');
    await expect(editor).toHaveAttribute('data-read-item', '公司A\n联系 [EMAIL_1]');
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

  test('ProseMirror 粘贴超长多行文本走单次整段插入，不逐行慢粘贴', async ({ page }) => {
    await setup(page, 'auto', true);
    const longText = '星辰科技\n' + '  第 N 行日志\t包含空格  \n\n'.repeat(600) + '结尾行';
    const expected = longText.replace('星辰科技', '公司A');
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      el.classList.add('ProseMirror');
      let pasteCount = 0;
      el.addEventListener('paste', (event) => {
        event.preventDefault();
        pasteCount += 1;
        el.setAttribute('data-paste-count', String(pasteCount));
        const html = (event as ClipboardEvent).clipboardData?.getData('text/html') ?? '';
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const paragraphs = [...doc.querySelectorAll('[data-pm-slice] > p')];
        el.textContent = (el.textContent ?? '') + paragraphs.map((p) => p.textContent).join('\n');
      });
    });
    await pasteInto(page, '#ce', longText);
    await expect(page.getByText(/VESPER 已脱敏 1 处/)).toBeVisible({ timeout: 5000 });
    await expect(editor).toHaveAttribute('data-paste-count', '1');
    expect(await editor.textContent()).toBe(expected);
  });

  test('通用现代富文本编辑器（Lexical/Slate 风格）长文本走单次纯文本 paste 回填', async ({
    page,
  }) => {
    await setup(page, 'auto', true);
    const longText = '星辰科技\n' + '普通正文行\n'.repeat(1000) + '最后一行';
    const expected = longText.replace('星辰科技', '公司A');
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      let pasteCount = 0;
      el.addEventListener('paste', (event) => {
        event.preventDefault();
        pasteCount += 1;
        el.setAttribute('data-paste-count', String(pasteCount));
        const plain = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
        el.textContent = (el.textContent ?? '') + plain;
      });
    });
    await pasteInto(page, '#ce', longText);
    await expect(page.getByText(/VESPER 已脱敏 1 处/)).toBeVisible({ timeout: 5000 });
    await expect(editor).toHaveAttribute('data-paste-count', '1');
    expect(await editor.textContent()).toBe(expected);
  });

  test('Gemini 风格 Quill 1 编辑器粘贴超长文本时直接走剪贴板兜底，不卡死且二次粘贴直接放行', async ({
    page,
  }) => {
    await setup(page, 'auto', true);
    const editor = page.locator('#ce');
    await editor.evaluate((el) => {
      el.classList.add('ql-editor');
      const clip = document.createElement('div');
      clip.className = 'ql-clipboard';
      el.parentElement!.appendChild(clip);
    });
    const huge = '星辰科技\n' + '第 N 行超长日志记录用于测试 Gemini Quill 1 兜底\n'.repeat(1200);
    const expected = huge.replace('星辰科技', '公司A');

    await pasteInto(page, '#ce', huge);
    await expect(page.getByText(/文本较长，已复制脱敏结果/)).toBeVisible({ timeout: 5000 });
    // 首贴未强塞 DOM，避免 Quill 1 O(N²) 假死
    await expect(editor).toHaveText('');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

    // 二次粘贴时由 approvedPaste 原生放行，不再被 VESPER 重复拦截
    await editor.evaluate((el) => {
      el.addEventListener(
        'paste',
        (event) => {
          event.preventDefault();
          el.setAttribute('data-native-paste', '1');
          el.textContent = (
            (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
          ).slice(0, 20);
        },
        { once: true },
      );
    });
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(editor).toHaveAttribute('data-native-paste', '1');
    expect(await editor.textContent()).toBe(expected.slice(0, 20));
  });

  test('通用富文本编辑器粘贴超 128KB/2000 行文本直接复制脱敏结果，避免反复分批注入卡死', async ({
    page,
  }) => {
    await setup(page, 'auto', true);
    const editor = page.locator('#ce');
    const huge = '星辰科技\n' + '超长富文本行内容用于验证直接复制上限\n'.repeat(2500);
    const expected = huge.replace('星辰科技', '公司A');

    await pasteInto(page, '#ce', huge);
    await expect(page.getByText(/文本较长，已复制脱敏结果/)).toBeVisible({ timeout: 5000 });
    await expect(editor).toHaveText('');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
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
    await field.clear();
    await pasteInto(page, '#ta', large);
    await expect(busy(page)).toBeVisible();
    await finishRedaction(page, true);
    await expect(field).toHaveValue(large.replace('星辰科技', '公司A'));
  });

  test('实际切换方案时中止旧处理，迟到结果不会影响下一次粘贴', async ({ page }) => {
    await setup(page, 'auto', 'deferred');
    await pasteInto(page, '#ta', large);
    await expect(busy(page)).toBeVisible();

    const next = makeSiteState('auto');
    next.scheme.rules[0]!.replacement = '公司B';
    await setSiteState(page, next);
    await expect(page.getByText(/本次粘贴已取消/)).toBeVisible();
    await expect(busy(page)).toHaveCount(0);
    await finishRedaction(page, true);

    await pasteInto(page, '#ta', '星辰科技');
    await expect(page.locator('#ta')).toHaveValue('公司B');
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
