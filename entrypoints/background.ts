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
  getSchemes,
  getSettings,
  getSites,
  hostMatches,
  hostToOrigins,
  incrementDailyCount,
  pushMapping,
  saveSettings,
  urlToHost,
} from '@/src/storage';
import type { SiteStateResponse } from '@/src/messages';
import { genId } from '@/src/core/presets';
import { restore } from '@/src/core/restore';

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
  const last = await getLastMapping();
  const restored = restore(text, last?.mapping ?? {});
  const changed = restored !== text;
  await chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      func: (payload: { text: string; changed: boolean }) => {
        if (payload.changed) {
          void navigator.clipboard.writeText(payload.text).catch(() => {});
        }
        const tip = document.createElement('div');
        tip.textContent = payload.changed
          ? '✳ VESPER 已还原并复制'
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

/** 判断目标 origin 是否被已授权 origin 覆盖：相等或已授权全局通配权限 */
function originCoveredBy(target: string, grantedOrigins: string[]): boolean {
  return grantedOrigins.includes('*://*/*') || grantedOrigins.includes(target);
}

/**
 * 按 siteScope + 站点启用状态 + 主机权限，同步 content script 注册（文档 D5 / 4.4）。
 * - list 模式：逐站点按 host 派生两条 origin（根域 + 子域）注册，需两条均已授权。
 * - global 模式：注册单个覆盖全部站点的 content script（全局通配 matches），需全局通配权限已授权；
 *   排除名单由 GET_SITE_STATE 在运行时判定，不在此处区分注册。
 */
async function syncContentScriptRegistrations(): Promise<void> {
  const sites = await getSites();
  const settings = await getSettings();
  const scope = settings?.siteScope ?? 'list';
  const granted = await chrome.permissions.getAll();
  const origins = granted.origins ?? [];

  // 注销现有 VESPER 注册（站点级 vesper-site-* + 全局级 vesper-global）
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing.filter((s) => s.id.startsWith('vesper-'));
  if (ours.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: ours.map((s) => s.id) });
  }

  if (scope === 'global') {
    if (!origins.includes('*://*/*')) {
      console.debug('[VESPER] 全局模式未授权 *://*/*，content script 暂未注册');
      return;
    }
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: 'vesper-global',
          js: ['content-scripts/content.js'],
          matches: ['*://*/*'],
          runAt: 'document_start',
          persistAcrossSessions: true,
        },
      ]);
      console.debug('[VESPER] 全局 content script 已注册');
    } catch (err) {
      console.warn('[VESPER] 全局 content script 注册失败:', (err as Error).message);
    }
    return;
  }

  // list 模式：逐站点注册 + 单站点失败不拖垮整批（此前一批注册会因单个非法 pattern 整体静默失败）
  let ok = 0;
  for (const s of sites) {
    if (!s.enabled || !s.host) continue;
    const siteOrigins = hostToOrigins(s.host);
    // 两条 origin 都必须已授权，否则 chrome.scripting 会因未授权 host 整批失败
    if (!siteOrigins.every((o) => originCoveredBy(o, origins))) continue;
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: `vesper-site-${s.id}`,
          js: ['content-scripts/content.js'],
          matches: siteOrigins,
          runAt: 'document_start',
          persistAcrossSessions: true,
        },
      ]);
      ok += 1;
    } catch (err) {
      // 只记录错误本身，不打印任何用户规则内容（隐私红线）
      console.warn(`[VESPER] 站点 ${s.host} 注册失败:`, (err as Error).message);
    }
  }
  if (sites.some((s) => s.enabled)) {
    console.debug(`[VESPER] content script 注册完成：${ok} 个站点生效`);
  }
}

export default defineBackground(() => {
  // 启动即播种（幂等）并同步注册
  void ensureSeeded().then(syncContentScriptRegistrations);

  chrome.runtime.onInstalled.addListener(() => {
    void ensureSeeded().then(syncContentScriptRegistrations);

    // 右键菜单：打开工作台 + 选中即脱敏（文档 T7）
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'vesper-open-workbench',
        title: '打开 VESPER 工作台',
        contexts: ['action', 'page'],
      });
      chrome.contextMenus.create({
        id: 'vesper-desensitize-selection',
        title: '用 VESPER 脱敏选中文本',
        contexts: ['selection'],
      });
      chrome.contextMenus.create({
        id: 'vesper-restore-selection',
        title: '用 VESPER 还原选中文本',
        contexts: ['selection'],
      });
    });
  });

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

  // 权限变化 → 重新同步注册（站点启用/停用时由 options 主动发消息触发）
  chrome.permissions.onAdded.addListener(() => void syncContentScriptRegistrations());
  chrome.permissions.onRemoved.addListener(() => void syncContentScriptRegistrations());

  // 消息路由
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    void (async () => {
      switch (msg?.type) {
        case 'GET_ACTIVE_SCHEME':
          return (await getActiveScheme()) ?? null;
        case 'GET_SCHEMES':
          return await getSchemes();
        case 'SET_ACTIVE_SCHEME': {
          const settings = await getSettings();
          if (settings) {
            settings.activeSchemeId = msg.schemeId;
            await saveSettings(settings);
          }
          return;
        }
        case 'GET_SITE_STATE': {
          const settings = await getSettings();
          // 总开关关闭：仍返回站点信息供 Popup 展示，但状态为 disabled
          if (settings?.globalEnabled === false) {
            const site = await findSiteByUrl(msg.url);
            return (site
              ? { status: 'disabled', site }
              : { status: 'unconfigured' }) satisfies SiteStateResponse;
          }
          const scope = settings?.siteScope ?? 'list';
          const host = urlToHost(msg.url);

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
            // 全局模式无具体站点，构造虚拟站点（默认预览模式）；scheme 用当前方案
            return {
              status: 'enabled',
              site: {
                id: 'vesper-global',
                host: '',
                schemeId: '',
                enabled: true,
                mode: 'preview',
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
