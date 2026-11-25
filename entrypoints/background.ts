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
  getLatestMapping,
  getSchemes,
  getSettings,
  getSites,
  getUpdateState,
  hostMatches,
  hostToOrigins,
  incrementDailyCount,
  pushMapping,
  saveUpdateState,
  updateSettings,
  urlToHost,
} from '@/src/storage';
import type { SiteStateResponse } from '@/src/messages';
import { genId } from '@/src/core/presets';
import { restore } from '@/src/core/restore';
import {
  GITHUB_LATEST_API_URL,
  parseGithubReleasePayload,
  type UpdateState,
} from '@/src/core/update';
import { VESPER_LOGO_PATHS, VESPER_LOGO_VIEWBOX } from '@/src/brand';

const UPDATE_ALARM_NAME = 'vesper-check-update';
const UPDATE_CHECK_INTERVAL_MINUTES = 12 * 60; // 12 小时定期检查
const UPDATE_CHECK_INTERVAL_MS = UPDATE_CHECK_INTERVAL_MINUTES * 60 * 1000;
let checkingUpdate: Promise<UpdateState> | undefined;

async function doCheckForUpdates(): Promise<UpdateState> {
  const previous = await getUpdateState();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(GITHUB_LATEST_API_URL, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (resp.status === 404) {
      const next: UpdateState = { checkedAt: Date.now() };
      await saveUpdateState(next);
      return next;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data: unknown = await resp.json();
    const parsed = parseGithubReleasePayload(data, Date.now());
    // 若本次解析异常但此前已有有效版本缓存，保留最新已知版本供红点判断
    const next: UpdateState = parsed.lastError
      ? {
          ...previous,
          checkedAt: parsed.checkedAt,
          lastError: parsed.lastError,
        }
      : parsed;
    await saveUpdateState(next);
    return next;
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? '连接超时'
        : err instanceof Error
          ? err.message
          : '网络请求失败';
    const next: UpdateState = {
      ...previous,
      checkedAt: previous?.checkedAt ?? 0,
      lastError: message,
    };
    await saveUpdateState(next);
    return next;
  } finally {
    clearTimeout(timer);
  }
}

async function checkForUpdates(force = false): Promise<UpdateState> {
  if (!force && !checkingUpdate) {
    const cached = await getUpdateState();
    if (cached?.checkedAt && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
      return cached;
    }
  }
  return (checkingUpdate ??= doCheckForUpdates().finally(() => {
    checkingUpdate = undefined;
  }));
}

let alarmQueue: Promise<void> = Promise.resolve();

function syncUpdateAlarm(): Promise<void> {
  alarmQueue = alarmQueue.then(doSyncUpdateAlarm).catch(() => {});
  return alarmQueue;
}

async function doSyncUpdateAlarm(): Promise<void> {
  if (!chrome.alarms) return;
  const settings = await getSettings();
  const enabled = settings?.autoCheckUpdate ?? true;
  if (!enabled) {
    await chrome.alarms.clear(UPDATE_ALARM_NAME);
    return;
  }
  const existing = await chrome.alarms.get(UPDATE_ALARM_NAME);
  if (!existing) {
    const state = await getUpdateState();
    const overdue = !state?.checkedAt || Date.now() - state.checkedAt >= UPDATE_CHECK_INTERVAL_MS;
    await chrome.alarms.create(UPDATE_ALARM_NAME, {
      delayInMinutes: overdue ? 1 : UPDATE_CHECK_INTERVAL_MINUTES,
      periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
    });
  }
}

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

/** 打开工作台页（优先复用已有工作台标签页，避免重复堆积多个标签） */
async function openWorkbench(): Promise<void> {
  const url = chrome.runtime.getURL('/workbench.html');
  try {
    const existing = await chrome.tabs.query({ url });
    const tab = existing.find((t) => t.id != null);
    if (tab?.id != null) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      return;
    }
  } catch {
    // 降级新建标签页
  }
  await chrome.tabs.create({ url });
}

const SIDEBAR_FALLBACK_WIDTH = 420;
const SIDEBAR_FALLBACK_HEIGHT = 760;
const FALLBACK_WINDOW_KEY = 'vesper:fallbackWindowId';
const NATIVE_SIDEPANEL_BROKEN_KEY = 'vesper:nativeSidePanelBroken';
const IS_ARC_KEY = 'vesper:isArc';
let openingFallback: Promise<void> | undefined;

async function isNativeSidePanelBypassed(): Promise<boolean> {
  const [localData, sessionData] = await Promise.all([
    chrome.storage.local.get(IS_ARC_KEY).catch(() => ({}) as Record<string, unknown>),
    chrome.storage.session
      .get(NATIVE_SIDEPANEL_BROKEN_KEY)
      .catch(() => ({}) as Record<string, unknown>),
  ]);
  return Boolean(localData[IS_ARC_KEY] || sessionData[NATIVE_SIDEPANEL_BROKEN_KEY]);
}

/**
 * 侧边栏独立窗口兜底（用于 Arc 等不支持原生 sidePanel 或创建无界面幽灵 SIDE_PANEL 的浏览器）。
 * 使用 ?mode=window 区分原生宿主，贴靠当前浏览器窗口右侧边缘打开紧凑型 popup 窗口。
 */
function openSidePanelFallbackWindow(preferredWindowId?: number): Promise<void> {
  return (openingFallback ??= (async () => {
    const url = `${chrome.runtime.getURL('/sidepanel.html')}?mode=window`;

    // 优先聚焦已打开且真实存活的独立侧边栏窗口（不盲目用 tabs.query 以免误中幽灵视图）
    const sessionObj = await chrome.storage.session
      .get(FALLBACK_WINDOW_KEY)
      .catch(() => ({}) as Record<string, unknown>);
    const savedWinId = sessionObj[FALLBACK_WINDOW_KEY];
    if (typeof savedWinId === 'number') {
      const existingWin = await chrome.windows
        .get(savedWinId, { populate: true })
        .catch(() => null);
      if (existingWin?.id != null && (existingWin.tabs?.length ?? 0) > 0) {
        await chrome.windows
          .update(existingWin.id, {
            focused: true,
            ...(existingWin.state === 'minimized' ? { state: 'normal' } : {}),
          })
          .catch(() => {});
        return;
      }
      await chrome.storage.session.remove(FALLBACK_WINDOW_KEY).catch(() => {});
    }

    let bounds: { left?: number; top?: number; height: number } = {
      height: SIDEBAR_FALLBACK_HEIGHT,
    };
    try {
      const refWin =
        preferredWindowId != null
          ? await chrome.windows.get(preferredWindowId)
          : await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (refWin && refWin.state !== 'fullscreen' && refWin.state !== 'minimized') {
        const winWidth = Math.round(refWin.width ?? 1200);
        const winHeight = Math.max(480, Math.round(refWin.height ?? SIDEBAR_FALLBACK_HEIGHT));
        const winLeft = Math.round(refWin.left ?? 0);
        const winTop = Math.round(refWin.top ?? 40);
        bounds = {
          left: winLeft + Math.max(0, winWidth - SIDEBAR_FALLBACK_WIDTH),
          top: winTop,
          height: winHeight,
        };
      }
    } catch {
      // 忽略宿主窗口几何信息读取失败，使用默认尺寸
    }

    let created: chrome.windows.Window | undefined;
    try {
      created = await chrome.windows.create({
        url,
        type: 'popup',
        width: SIDEBAR_FALLBACK_WIDTH,
        ...bounds,
        focused: true,
      });
    } catch {
      try {
        created = await chrome.windows.create({
          url,
          type: 'popup',
          width: SIDEBAR_FALLBACK_WIDTH,
          height: SIDEBAR_FALLBACK_HEIGHT,
          focused: true,
        });
      } catch {
        await chrome.tabs.create({ url, active: true });
        return;
      }
    }

    if (created?.id != null) {
      await chrome.storage.session.set({ [FALLBACK_WINDOW_KEY]: created.id }).catch(() => {});
    }
  })().finally(() => {
    openingFallback = undefined;
  }));
}

async function pingNativeSidePanel(): Promise<{ visible: boolean; isArc?: boolean } | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'PING_NATIVE_SIDE_PANEL' })) as
      { visible?: boolean; isArc?: boolean } | undefined;
    if (!res || typeof res.visible !== 'boolean') return null;
    return { visible: res.visible, isArc: res.isArc };
  } catch {
    return null;
  }
}

/**
 * 核验原生 sidePanel 是否真实可见：
 * 在 Arc 中，chrome.sidePanel.open 可能静默挂起，或在内存中创建未挂载到任何原生视图的隐藏
 * SIDE_PANEL WebContents（此时 getContexts 仍返回非空，但页面不可见/未触发渲染帧）。
 * 通过主动向原生侧边栏视图发起可见性与渲染帧探活，未通过则自动标记并拉起独立侧边栏窗口。
 */
async function verifySidePanelOrFallback(preferredWindowId?: number): Promise<void> {
  if (await isNativeSidePanelBypassed()) {
    await openSidePanelFallbackWindow(preferredWindowId);
    return;
  }
  for (const waitMs of [80, 160, 220]) {
    await new Promise((r) => setTimeout(r, waitMs));
    const pong = await pingNativeSidePanel();
    if (pong?.visible) return;
    if (pong?.isArc) break;
  }
  await chrome.storage.session.set({ [NATIVE_SIDEPANEL_BROKEN_KEY]: true }).catch(() => {});
  await openSidePanelFallbackWindow(preferredWindowId);
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
  const last = await getLatestMapping();
  const restored = restore(text, last?.mapping ?? {});
  const changed = restored !== text;
  await chrome.scripting
    .executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      func: async (payload: {
        text: string;
        changed: boolean;
        logoViewBox: string;
        logoPaths: readonly string[];
      }) => {
        const copied =
          payload.changed &&
          (await navigator.clipboard?.writeText(payload.text).then(
            () => true,
            () => false,
          ));
        document.getElementById('vesper-restore-tip')?.remove();
        const tip = document.createElement('div');
        tip.id = 'vesper-restore-tip';
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', payload.logoViewBox);
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.cssText = 'display:inline-block;flex:none;vertical-align:middle;';
        for (const d of payload.logoPaths) {
          const path = document.createElementNS(svgNs, 'path');
          path.setAttribute('d', d);
          svg.appendChild(path);
        }
        const msg = payload.changed
          ? copied
            ? 'VESPER 已还原并复制'
            : '已还原，但写入剪贴板失败'
          : '未检测到可还原的占位符（请先用 VESPER 脱敏）';
        tip.append(svg, document.createTextNode(msg));
        tip.style.cssText =
          'position:fixed;top:16px;right:16px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;background:#111111;color:#ffffff;padding:10px 14px;border-radius:8px;font:13px -apple-system,"PingFang SC",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2);';
        document.documentElement.appendChild(tip);
        setTimeout(() => tip.remove(), 2500);
      },
      args: [
        {
          text: restored,
          changed,
          logoViewBox: VESPER_LOGO_VIEWBOX,
          logoPaths: [...VESPER_LOGO_PATHS],
        },
      ],
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
    { id: 'vesper-open-sidepanel', title: '打开 VESPER 侧边栏', contexts: ['action', 'page'] },
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
      if (!granted) return [];
      return [
        {
          id,
          matches,
          js: ['content-scripts/content.js'],
          runAt: 'document_start' as const,
          world: 'ISOLATED' as const,
        },
        {
          id: `${id}-main`,
          matches,
          js: ['content-scripts/clipboard-guard.js'],
          runAt: 'document_start' as const,
          world: 'MAIN' as const,
        },
      ];
    }),
  );
  const desired = new Map(permitted.flat().map((script) => [script.id, script] as const));
  const removed: string[] = [];
  for (const script of existing) {
    if (!script.id.startsWith('vesper-')) continue;
    const next = desired.get(script.id);
    if (
      next &&
      (script.world ?? 'ISOLATED') === next.world &&
      script.js?.[0] === next.js[0] &&
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
  void chrome.sidePanel?.setOptions?.({ path: 'sidepanel.html', enabled: true }).catch(() => {});
  const ready = ensureSeeded();
  void ready
    .then(() => Promise.all([syncContentScriptRegistrations(), syncUpdateAlarm()]))
    .catch(() => console.warn('[VESPER] 初始化失败'));

  chrome.runtime.onInstalled.addListener(() => {
    // 右键菜单：打开工作台 + 选中即脱敏（文档 T7）
    void setupContextMenus();
    void ready.then(syncUpdateAlarm).catch(() => {});
  });

  // 浏览器启动时补一次菜单与更新检查定时器
  chrome.runtime.onStartup.addListener(() => {
    void setupContextMenus();
    void ready.then(syncUpdateAlarm).catch(() => {});
  });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name !== UPDATE_ALARM_NAME) return;
    void (async () => {
      await ready;
      if ((await getSettings())?.autoCheckUpdate ?? true) {
        await checkForUpdates(false);
      }
    })();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['vesper:settings']) {
      void syncUpdateAlarm();
    }
  });

  // 快捷键 open-workbench（manifest commands）
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-workbench') void openWorkbench();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'vesper-open-workbench') {
      void openWorkbench();
    } else if (info.menuItemId === 'vesper-open-sidepanel') {
      const targetWindowId = tab?.windowId;
      const targetTabId = tab?.id;
      let openPromise: Promise<void> | undefined;
      if (chrome.sidePanel?.open && (targetWindowId != null || targetTabId != null)) {
        try {
          openPromise =
            targetWindowId != null
              ? chrome.sidePanel.open({ windowId: targetWindowId })
              : chrome.sidePanel.open({ tabId: targetTabId! });
        } catch {
          openPromise = undefined;
        }
      }
      if (openPromise) {
        void verifySidePanelOrFallback(targetWindowId);
        void openPromise.catch(() => openSidePanelFallbackWindow(targetWindowId));
      } else {
        void openSidePanelFallbackWindow(targetWindowId);
      }
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
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'PING_NATIVE_SIDE_PANEL') return false;
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
            if ((settings.siteScope ?? 'list') === 'global') {
              return { status: 'disabled' } satisfies SiteStateResponse;
            }
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
            if (!scheme || !scheme.enabled) {
              return {
                status: 'disabled',
                ...(scheme ? { scheme } : {}),
              } satisfies SiteStateResponse;
            }
            // 全局模式无具体站点，构造虚拟站点（拦截模式跟随用户配置）；scheme 用当前方案
            if (sender.tab?.id != null) {
              void chrome.scripting
                .executeScript({
                  target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
                  files: ['content-scripts/clipboard-guard.js'],
                  world: 'MAIN',
                })
                .catch(() => {});
            }
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
          const schemes = await getSchemes();
          const scheme =
            // schemeId 为空 = 跟随当前方案（Popup 切换即生效）；
            // 非空但已失效（方案被删）时同样回退当前方案
            schemes.find((s) => s.id === site.schemeId && site.schemeId !== '') ??
            schemes.find((s) => s.id === settings?.activeSchemeId) ??
            schemes.find((s) => s.isDefault) ??
            schemes[0];
          if (!scheme || !scheme.enabled) {
            return {
              status: 'disabled',
              site,
              ...(scheme ? { scheme } : {}),
            } satisfies SiteStateResponse;
          }
          if (sender.tab?.id != null) {
            void chrome.scripting
              .executeScript({
                target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
                files: ['content-scripts/clipboard-guard.js'],
                world: 'MAIN',
              })
              .catch(() => {});
          }
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
        case 'CHECK_UPDATE':
          return await checkForUpdates(Boolean(msg.force));
        case 'OPEN_WORKBENCH':
          await openWorkbench();
          return;
        case 'OPEN_SIDE_PANEL_FALLBACK':
          await openSidePanelFallbackWindow(msg.windowId);
          return;
        case 'VERIFY_SIDE_PANEL_OPENED':
          void verifySidePanelOrFallback(msg.windowId);
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
