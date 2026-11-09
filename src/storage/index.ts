/**
 * 存储层（VESPEER.md D4 / T4）：仅使用 chrome.storage.local。
 *
 * 红线：
 * - 禁止 chrome.storage.sync（规则库含真实敏感词，同步即外泄）。
 * - 本层所有函数只读写数据，禁止 console.log 打印内容。
 * - 导入 JSON 必须结构校验，非法文件拒绝（文档 8.4）。
 *
 * 键位规划：
 * - vesper:schemes   Scheme[]
 * - vesper:sites     SiteRule[]
 * - vesper:settings  Settings
 * - vesper:mappings  最近映射（默认不开启；开启后最多 20 条，文档 4.7）
 * - vesper:meta      { schemaVersion }（数据迁移用）
 */
import {
  createDefaultScheme,
  DEFAULT_EXCLUDE_HOSTS,
  genId,
  normalizeHost,
  PRESET_HOST_CATEGORY,
  PRESET_SITES,
} from '../core/presets';
import type { Scheme, SiteRule, SiteScope } from '../core/types';

export interface Settings {
  globalEnabled: boolean;
  activeSchemeId: string;
  /** 今日计数按日期分桶：{ date: 'YYYY-MM-DD', count } */
  dailyCount: { date: string; count: number };
  /** 是否把最近映射保留到本地（默认关，文档 4.7） */
  persistMappings: boolean;
  /** 站点作用范围（文档 4.4）：'list' 名单模式（默认）/ 'global' 全局模式 */
  siteScope: SiteScope;
  /** 全局模式下的排除名单（域名数组）；list 模式下忽略 */
  excludeHosts: string[];
}

export interface MappingRecord {
  id: string;
  createdAt: number;
  schemeId: string;
  mapping: Record<string, string>;
}

const KEYS = {
  schemes: 'vesper:schemes',
  sites: 'vesper:sites',
  settings: 'vesper:settings',
  mappings: 'vesper:mappings',
  meta: 'vesper:meta',
} as const;

async function get<T>(key: string): Promise<T | undefined> {
  const obj = await chrome.storage.local.get(key);
  return obj[key] as T | undefined;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/**
 * 站点 schemeId 语义（2026-10-24 修订）：
 * - 空字符串 = "跟随当前方案"：拦截使用 Popup/工作台选中的 activeSchemeId；
 * - 非空 = 显式绑定某个方案（文档 4.4 的站点绑定能力保留）。
 * 预置站点与新建站点默认跟随当前方案，避免"Popup 切了方案、拦截还用旧方案"的坑。
 */
export const FOLLOW_ACTIVE_SCHEME = '';

const SCHEMA_VERSION = 7;

/** 首次安装播种：默认方案 + 预置站点（未启用）+ 默认设置；含 schema 版本标记 */
export async function ensureSeeded(): Promise<void> {
  const meta = await get<{ schemaVersion: number }>(KEYS.meta);
  if (meta?.schemaVersion === SCHEMA_VERSION) return;

  const schemes = await get<Scheme[]>(KEYS.schemes);
  if (!schemes || schemes.length === 0) {
    await set(KEYS.schemes, [createDefaultScheme()]);
  }
  const sites = await get<SiteRule[]>(KEYS.sites);
  if (!sites || sites.length === 0) {
    await set(
      KEYS.sites,
      PRESET_SITES.map((s) => ({ ...s, id: genId(), schemeId: FOLLOW_ACTIVE_SCHEME })),
    );
  }
  const settings = await get<Settings>(KEYS.settings);
  if (!settings) {
    const defaultScheme = (await get<Scheme[]>(KEYS.schemes))?.[0];
    await set(KEYS.settings, {
      globalEnabled: true,
      activeSchemeId: defaultScheme?.id ?? '',
      dailyCount: { date: today(), count: 0 },
      persistMappings: false,
      siteScope: 'list',
      excludeHosts: [...DEFAULT_EXCLUDE_HOSTS],
    } satisfies Settings);
  }

  // v3 迁移：SiteRule 从 matchPattern 迁移到 host 字段。
  // 解析 *://host/* 或 *://*.host/* 提取根域 host；迁移后清空 matchPattern。
  if ((meta?.schemaVersion ?? 0) < 3) {
    const allSites = await getSites();
    let changed = false;
    const next = allSites.map((s) => {
      if (s.host) return s;
      const host = matchPatternToHost(s.matchPattern ?? '');
      if (!host) return s;
      changed = true;
      return { ...s, host, matchPattern: undefined };
    });
    if (changed) await saveSites(next);
  }

  // v4 迁移：为站点补 category 字段。预置 host 用 PRESET_HOST_CATEGORY，其余标 'custom'。
  if ((meta?.schemaVersion ?? 0) < 4) {
    const allSites = await getSites();
    let changed = false;
    const next = allSites.map((s) => {
      if (s.category) return s;
      changed = true;
      return { ...s, category: PRESET_HOST_CATEGORY[s.host] ?? 'custom' };
    });
    if (changed) await saveSites(next);
  }

  // v5 迁移：补全缺失的预置站点。老用户升级时把扩充的预置库补齐
  //（沿用预置默认启用状态，不干扰用户已有启停配置）；用户删过的预置会被加回一次，可再删。
  if ((meta?.schemaVersion ?? 0) < 5) {
    const allSites = await getSites();
    const existingHosts = new Set(allSites.map((s) => normalizeHost(s.host)));
    let changed = false;
    const next = [...allSites];
    for (const p of PRESET_SITES) {
      if (!existingHosts.has(normalizeHost(p.host))) {
        changed = true;
        next.push({ ...p, id: genId(), schemeId: FOLLOW_ACTIVE_SCHEME });
      }
    }
    if (changed) await saveSites(next);
  }

  // v6 迁移：内置预置站点默认启用（黑名单模式开箱全选，预览确认）。
  if ((meta?.schemaVersion ?? 0) < 6) {
    const allSites = await getSites();
    const presetHosts = new Set(PRESET_SITES.map((p) => normalizeHost(p.host)));
    let changed = false;
    const next = allSites.map((s) => {
      if (presetHosts.has(normalizeHost(s.host)) && !s.enabled) {
        changed = true;
        return { ...s, enabled: true };
      }
      return s;
    });
    if (changed) await saveSites(next);
  }

  // v7 迁移：全局模式补默认例外主机（本机回环 + 私有网段）。
  // 仅在用户例外列表为空时写入，已有自定义例外的不动。
  if ((meta?.schemaVersion ?? 0) < 7) {
    const current = await get<Settings>(KEYS.settings);
    if (current && (!current.excludeHosts || current.excludeHosts.length === 0)) {
      await set(KEYS.settings, { ...current, excludeHosts: [...DEFAULT_EXCLUDE_HOSTS] });
    }
  }

  // v2 迁移：预置站点若仍绑定默认方案（v1 种子行为），改为跟随当前方案。
  // 基于 host 匹配预置；用户自建站点的显式绑定不受影响。
  if ((meta?.schemaVersion ?? 0) < 2) {
    const allSchemes = await getSchemes();
    const defaultId = allSchemes.find((s) => s.isDefault)?.id;
    if (defaultId) {
      const presetHosts = PRESET_SITES.map((s) => s.host);
      const allSites = await getSites();
      let changed = false;
      const next = allSites.map((s) => {
        if (s.host && presetHosts.includes(s.host) && s.schemeId === defaultId) {
          changed = true;
          return { ...s, schemeId: FOLLOW_ACTIVE_SCHEME };
        }
        return s;
      });
      if (changed) await saveSites(next);
    }
  }

  await set(KEYS.meta, { schemaVersion: SCHEMA_VERSION });
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

// ---------- 方案 ----------

export async function getSchemes(): Promise<Scheme[]> {
  return (await get<Scheme[]>(KEYS.schemes)) ?? [];
}

export async function saveSchemes(schemes: Scheme[]): Promise<void> {
  await set(KEYS.schemes, schemes);
}

export async function getActiveScheme(): Promise<Scheme | undefined> {
  const [schemes, settings] = await Promise.all([getSchemes(), getSettings()]);
  return (
    schemes.find((s) => s.id === settings?.activeSchemeId) ??
    schemes.find((s) => s.isDefault) ??
    schemes[0]
  );
}

// ---------- 站点 ----------

export async function getSites(): Promise<SiteRule[]> {
  return (await get<SiteRule[]>(KEYS.sites)) ?? [];
}

export async function saveSites(sites: SiteRule[]): Promise<void> {
  await set(KEYS.sites, sites);
}

/** 按 URL 找到命中的站点规则（host 后缀匹配：根域或其任意子域） */
export async function findSiteByUrl(url: string): Promise<SiteRule | undefined> {
  const sites = await getSites();
  const host = urlToHost(url);
  if (!host) return undefined;
  return sites.find((s) => hostMatches(host, s.host));
}

/** 从 URL 提取 hostname（小写） */
export function urlToHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 点分 IPv4 → 32 位整数；非法返回 null */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/** host 是否落在 IPv4 CIDR 网段内（如 192.168.0.0/16）；非 IPv4 一律不命中 */
function ipv4InCidr(host: string, cidr: string): boolean {
  const [base = '', bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipv4ToInt(base);
  const hostInt = ipv4ToInt(host);
  if (baseInt == null || hostInt == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((baseInt & mask) >>> 0) === ((hostInt & mask) >>> 0);
}

/** 去掉 IPv6 字面量的方括号：URL.hostname 给的是 [::1]，用户可能写 ::1 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * 判断 urlHost 是否命中规则 ruleHost：
 * - '*' 匹配全部；'*.x' 与 'x' 均匹配根域及所有子域；
 * - 'a.b.c.d/nn' 按 IPv4 CIDR 网段匹配（如 192.168.0.0/16）；
 * - IPv6 字面量按无括号形式比较（[::1] ≡ ::1）。
 */
export function hostMatches(host: string, ruleHost: string): boolean {
  if (!host || !ruleHost) return false;
  const rule = ruleHost.trim().toLowerCase();
  if (rule === '*') return true;
  const h = host.trim().toLowerCase();
  if (rule.includes('/')) return ipv4InCidr(h, rule);
  const base = normalizeHost(rule);
  if (h.startsWith('[') || base.startsWith('[')) return stripBrackets(h) === stripBrackets(base);
  return h === base || h.endsWith('.' + base);
}

/** 由 host 派生 origin（根域 + 子域两条；'*' 派生全局一条），用于权限申请与 content script 注册 */
export function hostToOrigins(host: string): string[] {
  if (host === '*') return ['*://*/*'];
  const base = normalizeHost(host);
  return [`*://${base}/*`, `*://*.${base}/*`];
}

/** 从旧 matchPattern（*://host/* 或 *://*.host/*）提取根域 host；失败返回空串（迁移用） */
export function matchPatternToHost(pattern: string): string {
  const m = pattern.match(/^\*{0,2}[a-z*]+:\/\/(\*\.)?([^/\s]+)\/\*?$/i);
  return m?.[2]?.toLowerCase() ?? '';
}

// ---------- 设置 ----------

export async function getSettings(): Promise<Settings | undefined> {
  return get<Settings>(KEYS.settings);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(KEYS.settings, settings);
}

// ---------- 计数（仅本地，文档 4.5） ----------

export async function incrementDailyCount(by = 1): Promise<number> {
  const settings = await getSettings();
  if (!settings) return 0;
  const d = today();
  const count = settings.dailyCount.date === d ? settings.dailyCount.count + by : by;
  settings.dailyCount = { date: d, count };
  await saveSettings(settings);
  return count;
}

export async function getDailyCount(): Promise<number> {
  const settings = await getSettings();
  if (!settings || settings.dailyCount.date !== today()) return 0;
  return settings.dailyCount.count;
}

// ---------- 映射（文档 4.7：默认不持久化） ----------

export async function getMappings(): Promise<MappingRecord[]> {
  return (await get<MappingRecord[]>(KEYS.mappings)) ?? [];
}

export async function pushMapping(rec: MappingRecord): Promise<void> {
  // 最近一次映射始终写入 session（供右键还原 / 工作台还原；关闭浏览器即销毁）
  await chrome.storage.session.set({ 'vesper:lastMapping': rec });
  const settings = await getSettings();
  if (!settings?.persistMappings) return; // 默认关：不持久化到 local
  const list = await getMappings();
  list.unshift(rec);
  await set(KEYS.mappings, list.slice(0, 20)); // 最多保留 20 次
}

/** 读取最近一次脱敏映射（session，供右键还原；persistMappings 关闭时也可用） */
export async function getLastMapping(): Promise<MappingRecord | undefined> {
  const obj = await chrome.storage.session.get('vesper:lastMapping');
  return obj['vesper:lastMapping'] as MappingRecord | undefined;
}

// ---------- 导入 / 导出 / 清除 ----------

export interface ExportBundle {
  app: 'vesper';
  schemaVersion: number;
  exportedAt: number;
  schemes: Scheme[];
  sites: SiteRule[];
  settings: Omit<Settings, 'dailyCount'>;
}

export async function exportAll(): Promise<ExportBundle> {
  const [schemes, sites, settings] = await Promise.all([getSchemes(), getSites(), getSettings()]);
  return {
    app: 'vesper',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    schemes,
    sites,
    settings: {
      globalEnabled: settings?.globalEnabled ?? true,
      activeSchemeId: settings?.activeSchemeId ?? '',
      persistMappings: settings?.persistMappings ?? false,
      siteScope: settings?.siteScope ?? 'list',
      excludeHosts: settings?.excludeHosts ?? [],
    },
  };
}

/** 导入结构校验：任一字段不合法即整体拒绝（文档 8.4），返回错误信息或 null */
export function validateImport(data: unknown): string | null {
  if (typeof data !== 'object' || data == null) return '文件不是合法的 JSON 对象';
  const d = data as Partial<ExportBundle>;
  if (d.app !== 'vesper') return '不是 VESPER 导出的文件';
  if (!Array.isArray(d.schemes)) return '缺少方案列表';
  for (const s of d.schemes) {
    if (
      typeof s?.id !== 'string' ||
      typeof s?.name !== 'string' ||
      typeof s?.enabled !== 'boolean' ||
      !Array.isArray(s?.rules)
    ) {
      return '方案结构不合法';
    }
    for (const r of s.rules) {
      if (
        typeof r?.id !== 'string' ||
        !['keyword', 'regex', 'builtin'].includes(r?.type) ||
        typeof r?.pattern !== 'string' ||
        !['fixed', 'numbered', 'mask'].includes(r?.mode)
      ) {
        return `规则结构不合法：${r?.name ?? r?.id ?? '未知规则'}`;
      }
    }
  }
  if (!Array.isArray(d.sites)) return '缺少站点列表';
  for (const s of d.sites) {
    if (typeof s?.id !== 'string' || typeof s?.host !== 'string') {
      return '站点结构不合法';
    }
  }
  return null;
}

export async function importAll(bundle: ExportBundle): Promise<void> {
  const err = validateImport(bundle);
  if (err) throw new Error(err);
  await set(KEYS.schemes, bundle.schemes);
  await set(KEYS.sites, bundle.sites);
  const current = await getSettings();
  await saveSettings({
    ...bundle.settings,
    dailyCount: current?.dailyCount ?? { date: today(), count: 0 },
  });
}

/** 一键清除全部本地数据（文档 4.4） */
export async function clearAll(): Promise<void> {
  await chrome.storage.local.clear();
  await ensureSeeded();
}
