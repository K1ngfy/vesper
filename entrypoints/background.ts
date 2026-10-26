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
  getSchemes,
  getSettings,
  getSites,
  incrementDailyCount,
  pushMapping,
  saveSettings,
} from '@/src/storage';
import type { SiteStateResponse } from '@/src/messages';
import { genId } from '@/src/core/presets';

/** 打开工作台页（新标签页） */
async function openWorkbench(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('/workbench.html') });
}

/** 站点 matchPattern 是否被已授权 origin 覆盖（精确匹配或全主机通配授权） */
function patternCoveredBy(matchPattern: string, origin: string): boolean {
  if (origin === '*://*/*') return true;
  return origin === matchPattern;
}

/** 校验 match pattern 形如 *://host/*（chrome.scripting 注册前预检） */
function isValidMatchPattern(pattern: string): boolean {
  return (
    /^\*{0,2}[a-z*]+:\/\/[^/\s]+\/\*?$/i.test(pattern) || /^https?:\/\/[^/\s]+\/\*?$/.test(pattern)
  );
}

/** 按站点启用状态 + 主机权限，同步 content script 注册 */
async function syncContentScriptRegistrations(): Promise<void> {
  const sites = await getSites();
  const granted = await chrome.permissions.getAll();
  const origins = granted.origins ?? [];

  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing.filter((s) => s.id.startsWith('vesper-site-'));
  if (ours.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: ours.map((s) => s.id) });
  }

  // 逐站点注册 + 单站点失败不拖垮整批（此前一批注册会因单个非法 pattern 整体静默失败）
  let ok = 0;
  for (const s of sites) {
    if (!s.enabled) continue;
    if (!s.matchPattern) continue;
    if (!origins.some((o) => patternCoveredBy(s.matchPattern, o))) continue;
    try {
      if (!isValidMatchPattern(s.matchPattern)) {
        console.warn(`[VESPER] 站点 ${s.matchPattern} 的匹配模式不合法，已跳过注册`);
        continue;
      }
      await chrome.scripting.registerContentScripts([
        {
          id: `vesper-site-${s.id}`,
          js: ['content-scripts/content.js'],
          matches: [s.matchPattern],
          runAt: 'document_start',
          persistAcrossSessions: true,
        },
      ]);
      ok += 1;
    } catch (err) {
      // 只记录错误本身，不打印任何用户规则内容（隐私红线）
      console.warn(`[VESPER] 站点 ${s.matchPattern} 注册失败:`, (err as Error).message);
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
    });
  });

  // 快捷键 open-workbench（manifest commands）
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-workbench') void openWorkbench();
  });

  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'vesper-open-workbench') {
      void openWorkbench();
    } else if (info.menuItemId === 'vesper-desensitize-selection' && info.selectionText) {
      // 选中文本暂存 session，工作台打开后自动读取（关闭即销毁）
      void chrome.storage.session
        .set({ 'vesper:pendingInput': info.selectionText })
        .then(openWorkbench);
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
          const site = await findSiteByUrl(msg.url);
          if (!site) return { status: 'unconfigured' } satisfies SiteStateResponse;
          const settings = await getSettings();
          if (!site.enabled || settings?.globalEnabled === false) {
            return { status: 'disabled', site } satisfies SiteStateResponse;
          }
          const granted = await chrome.permissions.contains({ origins: [site.matchPattern] });
          if (!granted) return { status: 'no-permission', site } satisfies SiteStateResponse;
          const scheme =
            // schemeId 为空 = 跟随当前方案（Popup 切换即生效）；
            // 非空但已失效（方案被删）时同样回退当前方案
            (await getSchemes()).find((s) => s.id === site.schemeId && site.schemeId !== '') ??
            (await getActiveScheme());
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
