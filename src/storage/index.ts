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
import { createDefaultScheme, genId, PRESET_SITES } from '../core/presets';
import type { Scheme, SiteRule } from '../core/types';

export interface Settings {
  globalEnabled: boolean;
  activeSchemeId: string;
  /** 今日计数按日期分桶：{ date: 'YYYY-MM-DD', count } */
  dailyCount: { date: string; count: number };
  /** 是否把最近映射保留到本地（默认关，文档 4.7） */
  persistMappings: boolean;
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

const SCHEMA_VERSION = 2;

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
    } satisfies Settings);
  }

  // v2 迁移：预置站点若仍绑定着默认方案（v1 种子行为），改为跟随当前方案。
  // 只处理 5 个预置匹配模式，用户自建站点的显式绑定不受影响。
  if ((meta?.schemaVersion ?? 0) < 2) {
    const allSchemes = await getSchemes();
    const defaultId = allSchemes.find((s) => s.isDefault)?.id;
    if (defaultId) {
      const presetPatterns = PRESET_SITES.map((s) => s.matchPattern);
      const allSites = await getSites();
      let changed = false;
      const next = allSites.map((s) => {
        if (presetPatterns.includes(s.matchPattern) && s.schemeId === defaultId) {
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

/** 按 URL 找到命中的站点规则（matchPattern 转正则，支持 * 通配） */
export async function findSiteByUrl(url: string): Promise<SiteRule | undefined> {
  const sites = await getSites();
  return sites.find((s) => matchPatternToRegex(s.matchPattern).test(url));
}

export function matchPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
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
  const settings = await getSettings();
  if (!settings?.persistMappings) return; // 默认关：不落盘
  const list = await getMappings();
  list.unshift(rec);
  await set(KEYS.mappings, list.slice(0, 20)); // 最多保留 20 次
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
    if (typeof s?.id !== 'string' || typeof s?.matchPattern !== 'string') {
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
