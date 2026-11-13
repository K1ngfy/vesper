/**
 * Background Service Worker（VESPEER.md 第 6/7 节）。
 *
 * 职责：种子数据、快捷键、右键菜单、消息路由、站点 content script 动态注册。
 * MV3 注意：SW 随时被回收，禁止在全局变量里存状态；一切状态落 chrome.storage。
 *
 * 动态注册说明（文档 D5 最小权限）：content script 不进 manifest 的静态
 * content_scripts，而是按"已启用且已授权"的站点用 chrome.scripting 运行时注册。
 * 站点停用或权限被收回时同步注销。
 */
import {
  ensureSeeded,
  findSiteByUrl,
  getActiveScheme,
  getDailyCount,
  getLastMapping,
  getMappings,
  getSchemes,
  getSettings,
  getSites,
  hostMatches,
  hostToOrigins,
  incrementDailyCount,
  pushMapping,
  updateSettings,
  urlToHost,
} from '@/src/storage';
import type { SiteStateResponse } from '@/src/messages';
import { genId } from '@/src/core/presets';
import { restore } from '@/src/core/restore';

const ENGINE_PAGE = '/engine.html';
let openingEngine: Promise<void> | undefined;

function ensureEnginePage(): Promise<void> {
  return (openingEngine ??= (async () => {
    const url = chrome.runtime.getURL(ENGINE_PAGE);
    const open =
      typeof chrome.runtime.getContexts === 'function'
        ? (
            await chrome.runtime.getContexts({
              contextTypes: ['OFFSCREEN_DOCUMENT'],
              documentUrls: [url],
            })
          ).length > 0
        : (
            await (
              self as unknown as { clients: { matchAll(): Promise<{ url: string }[]> } }
            ).clients.matchAll()
          ).some((client) => client.url === url);
    if (!open) {
      await chrome.offscreen.createDocument({
        url: ENGINE_PAGE,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run local redaction in a worker independent of the website CSP.',
      });
    }
  })().finally(() => {
    openingEngine = undefined;
  }));
}

/** 打开工作台页（新标签页） */
async function openWorkbench(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('/workbench.html') });
}

/**
 * 右键「还原选中文本」：用最近一次脱敏映射还原，复制结果并在页面提示。
 * 通过 executeScript 在当前标签页执行复制与提示（activeTab 权限由右键手势授予）。
 */
async function handleRestoreSelection(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): Promise<void> {
  const text = info.selectionText ?? '';
  if (!text || tab?.id == null) return;
  const last =
    (await getLastMapping()) ??
    ((await getSettings())?.persistMappings ? (await getMappings())[0] : undefined);
  const restored = restore(text, last?.mapping ?? {});
  const changed = restored !== text;
  await chrome.scripting
    .executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      func: async (payload: { text: string; changed: boolean }) => {
        const copied =
          payload.changed &&
          (await navigator.clipboard?.writeText(payload.text).then(
            () => true,
            () => false,
          ));
        const tip = document.createElement('div');
        tip.textContent = payload.changed
          ? copied
            ? '✳ VESPER 已还原并复制'
            : '✳ 已还原，但写入剪贴板失败'
          : '✳ 未检测到可还原的占位符（请先用 VESPER 脱敏）';
        tip.style.cssText =
          'position:fixed;top:16px;right:16px;z-index:2147483647;background:#111111;color:#ffffff;padding:10px 14px;border-radius:8px;font:13px -apple-system,"PingFang SC",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2);';
        document.documentElement.appendChild(tip);
        setTimeout(() => tip.remove(), 2500);
      },
      args: [{ text: restored, changed }],
    })
    .catch(() => {});
}

/**
 * 右键菜单创建（幂等）。
 *
 * 历史问题：SW 内 `removeAll(callback) → create` 是"回调式"的异步链，
 * onInstalled 在开发期/更新期可能连续触发多次，两次链交叠时就会
 * "Cannot create item with duplicate id vesper-xxx"（unchecked lastError）。
 * 这里改为：串行队列 + await removeAll + 逐条 create 并吃掉 lastError，
 * 重复 id 时退化为 update（保证文案是最新的），任何情况都不抛错。
 */
let menuQueue: Promise<void> = Promise.resolve();

function createMenusOnce(): Promise<void> {
  const items: chrome.contextMenus.CreateProperties[] = [
    { id: 'vesper-open-workbench', title: '打开 VESPER 工作台', contexts: ['action', 'page'] },
    {
      id: 'vesper-desensitize-selection',
      title: '用 VESPER 脱敏选中文本',
      contexts: ['selection'],
    },
    { id: 'vesper-restore-selection', title: '用 VESPER 还原选中文本', contexts: ['selection'] },
  ];

  return (async () => {
    try {
      await chrome.contextMenus.removeAll();
    } catch {
      /* 没有旧菜单时无需处理 */
    }
    for (const item of items) {
      await new Promise<void>((resolve) => {
        chrome.contextMenus.create(item, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            // 重复 id 属可恢复状态（并发/旧实例残留）：改成更新标题即可
            if (!/duplicate/i.test(err.message ?? '')) {
              console.warn('[VESPER] 右键菜单创建失败:', err.message);
            } else if (item.id) {
              void chrome.contextMenus
                .update(item.id, { title: item.title })
                .catch(() => undefined);
            }
          }
          resolve();
        });
      });
    }
  })();
}

function setupContextMenus(): Promise<void> {
  menuQueue = menuQueue.then(createMenusOnce).catch((err) => {
    console.warn('[VESPER] 右键菜单初始化失败:', (err as Error)?.message ?? err);
  });
  return menuQueue;
}

let syncQueue: Promise<void> = Promise.resolve();

function syncContentScriptRegistrations(): Promise<void> {
  syncQueue = syncQueue
    .then(doSyncRegistrations)
    .catch(() => console.warn('[VESPER] 内容脚本同步失败'));
  return syncQueue;
}

async function doSyncRegistrations(): Promise<void> {
  const [sites, settings, existing] = await Promise.all([
    getSites(),
    getSettings(),
    chrome.scripting.getRegisteredContentScripts(),
  ]);
  const candidates =
    settings?.siteScope === 'global'
      ? [{ id: 'vesper-global', matches: ['*://*/*'] }]
      : sites
          .filter((site) => site.enabled && site.host)
          .map((site) => ({
            id: `vesper-site-${site.id}`,
            matches: hostToOrigins(site.host),
          }));
  const permitted = await Promise.all(
    candidates.map(async ({ id, matches }) => {
      const granted = await chrome.permissions.contains({ origins: matches }).catch(() => false);
      return granted
        ? { id, matches, js: ['content-scripts/content.js'], runAt: 'document_start' as const }
        : null;
    }),
  );
  const desired = new Map(
    permitted.flatMap((script) => (script ? [[script.id, script] as const] : [])),
  );
  const removed: string[] = [];
  for (const script of existing) {
    if (!script.id.startsWith('vesper-')) continue;
    const next = desired.get(script.id);
    if (
      next &&
      next.matches.length === script.matches?.length &&
      next.matches.every((pattern) => script.matches!.includes(pattern))
    ) {
      desired.delete(script.id);
    } else {
      removed.push(script.id);
    }
  }
  if (removed.length) await chrome.scripting.unregisterContentScripts({ ids: removed });
  for (const script of desired.values()) {
    await chrome.scripting.registerContentScripts([script]).catch(() => {
      console.warn('[VESPER] 站点内容脚本注册失败');
    });
  }
}

export default defineBackground(() => {
  const ready = ensureSeeded();
  void ready.then(syncContentScriptRegistrations).catch(() => console.warn('[VESPER] 初始化失败'));

  chrome.runtime.onInstalled.addListener(() => {
    // 右键菜单：打开工作台 + 选中即脱敏（文档 T7）
    void setupContextMenus();
  });

  // 浏览器启动时补一次菜单（开发重载/异常清理后菜单可能缺失，创建是幂等的）
  chrome.runtime.onStartup.addListener(() => void setupContextMenus());

  // 快捷键 open-workbench（manifest commands）
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-workbench') void openWorkbench();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'vesper-open-workbench') {
      void openWorkbench();
    } else if (info.menuItemId === 'vesper-desensitize-selection' && info.selectionText) {
      // 选中文本暂存 session，工作台打开后自动读取（关闭即销毁）
      void chrome.storage.session
        .set({ 'vesper:pendingInput': info.selectionText })
        .then(openWorkbench);
    } else if (info.menuItemId === 'vesper-restore-selection' && info.selectionText) {
      void handleRestoreSelection(info, tab);
    }
  });

  function onPermissionChange() {
    void chrome.storage.local.set({ 'vesper:permissionsRevision': Date.now() }).catch(() => {});
    void syncContentScriptRegistrations();
  }
  chrome.permissions.onAdded.addListener(onPermissionChange);
  chrome.permissions.onRemoved.addListener(onPermissionChange);

  // 消息路由
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    void (async () => {
      await ready;
      switch (msg?.type) {
        case 'GET_ACTIVE_SCHEME':
          return (await getActiveScheme()) ?? null;
        case 'GET_SCHEMES':
          return await getSchemes();
        case 'SET_ACTIVE_SCHEME': {
          if ((await getSchemes()).some((scheme) => scheme.id === msg.schemeId)) {
            await updateSettings({ activeSchemeId: msg.schemeId });
          }
          return;
        }
        case 'GET_SITE_STATE': {
          const host = urlToHost(msg.url);
          if (!host) return { status: 'unconfigured' } satisfies SiteStateResponse;
          const settings = await getSettings();
          // 总开关关闭：仍返回站点信息供 Popup 展示，但状态为 disabled
          if (settings?.globalEnabled === false) {
            const site = await findSiteByUrl(msg.url);
            return (
              site ? { status: 'disabled', site } : { status: 'unconfigured' }
            ) satisfies SiteStateResponse;
          }
          const scope = settings?.siteScope ?? 'list';

          if (scope === 'global') {
            // 全局模式：排除名单内的 host 不拦截
            const excluded = (settings?.excludeHosts ?? []).some((eh) => hostMatches(host, eh));
            if (excluded) {
              return { status: 'disabled' } satisfies SiteStateResponse;
            }
            // 需 *://*/* 已授权
            const granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
            if (!granted) return { status: 'no-permission' } satisfies SiteStateResponse;
            const scheme = await getActiveScheme();
            if (!scheme) return { status: 'disabled' } satisfies SiteStateResponse;
            // 全局模式无具体站点，构造虚拟站点（拦截模式跟随用户配置）；scheme 用当前方案
            return {
              status: 'enabled',
              site: {
                id: 'vesper-global',
                host: '',
                schemeId: '',
                enabled: true,
                mode: settings?.globalMode ?? 'preview',
              },
              scheme,
            } satisfies SiteStateResponse;
          }

          // list 模式：按 URL 命中的站点规则判定
          const site = await findSiteByUrl(msg.url);
          if (!site) return { status: 'unconfigured' } satisfies SiteStateResponse;
          if (!site.enabled) return { status: 'disabled', site } satisfies SiteStateResponse;
          const siteOrigins = hostToOrigins(site.host);
          const granted = await chrome.permissions.contains({ origins: siteOrigins });
          if (!granted) return { status: 'no-permission', site } satisfies SiteStateResponse;
          const scheme =
            // schemeId 为空 = 跟随当前方案（Popup 切换即生效）；
            // 非空但已失效（方案被删）时同样回退当前方案
            (await getSchemes()).find((s) => s.id === site.schemeId && site.schemeId !== '') ??
            (await getActiveScheme());
          if (!scheme) return { status: 'disabled', site } satisfies SiteStateResponse;
          return { status: 'enabled', site, scheme } satisfies SiteStateResponse;
        }
        case 'INCREMENT_COUNT':
          return await incrementDailyCount(msg.by ?? 1);
        case 'GET_DAILY_COUNT':
          return await getDailyCount();
        case 'RECORD_MAPPING':
          await pushMapping({
            id: genId(),
            createdAt: Date.now(),
            schemeId: msg.schemeId,
            mapping: msg.mapping,
          });
          return;
        case 'REFRESH_SITE_REGISTRATIONS':
          await syncContentScriptRegistrations();
          return;
        case 'ENSURE_ENGINE':
          await ensureEnginePage();
          return true;
        case 'OPEN_WORKBENCH':
          await openWorkbench();
          return;
        default:
          return;
      }
    })()
      .then(sendResponse)
      .catch(() => sendResponse(undefined));
    return true; // 异步响应
  });
});
