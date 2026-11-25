/**
 * 版本比较与 GitHub Release 更新解析（纯 TS，零浏览器 API 依赖，便于单测）。
 *
 * 安全与隐私约束：
 * - 仅请求公开的 GitHub Releases 最新正式版接口，不携带任何用户数据或凭据；
 * - 忽略 draft / prerelease 预发布版本，防止测试版误触发红点；
 * - 严格校验跳转链接必须位于官方仓库域名路径下，防止异常响应注入外部链接。
 */

export const GITHUB_REPO = 'K1ngfy/vesper';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
export const GITHUB_LATEST_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface UpdateState {
  checkedAt: number;
  latestVersion?: string;
  releaseUrl?: string;
  publishedAt?: string;
  lastError?: string;
}

interface ParsedSemver {
  parts: number[];
  prerelease: string;
}

function parseVersion(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^[vV]/, '').split('+')[0] ?? '';
  if (!cleaned) return null;
  const hyphenIdx = cleaned.indexOf('-');
  const core = hyphenIdx === -1 ? cleaned : cleaned.slice(0, hyphenIdx);
  const prerelease = hyphenIdx === -1 ? '' : cleaned.slice(hyphenIdx + 1);
  if (!core) return null;
  const segments = core.split('.');
  const parts: number[] = [];
  for (const seg of segments) {
    if (!/^\d+$/.test(seg)) return null;
    parts.push(Number(seg));
  }
  return { parts, prerelease };
}

/** 规范化版本号（去掉前导 v/V）；非法版本号返回空串 */
export function normalizeVersion(raw: string): string {
  const parsed = parseVersion(raw);
  if (!parsed) return '';
  const core = parsed.parts.join('.');
  return parsed.prerelease ? `${core}-${parsed.prerelease}` : core;
}

function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) return Number(sa) > Number(sb) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    return sa > sb ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两个语义化版本号：a > b 返回 1，a < b 返回 -1，相等或无法解析时返回 0。
 * 正式版高于同主次修订号的预发布版（如 0.2.8 > 0.2.8-rc.1）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa.parts[i] ?? 0;
    const vb = pb.parts[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease === pb.prerelease) return 0;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** candidate 是否比 current 更新 */
export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** 判断缓存的更新状态相对当前已安装版本是否存在可用新版本 */
export function hasAvailableUpdate(currentVersion: string, state?: UpdateState | null): boolean {
  if (!state?.latestVersion) return false;
  return isNewerVersion(currentVersion, state.latestVersion);
}

/** 校验并清洗 GitHub Release 页面 URL，仅允许指向本仓库下 https 页面 */
export function sanitizeReleaseUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) return GITHUB_RELEASES_URL;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      parsed.pathname.toLowerCase().startsWith(`/${GITHUB_REPO.toLowerCase()}/`)
    ) {
      return parsed.toString();
    }
  } catch {
    // 回退到默认 Releases 列表页
  }
  return GITHUB_RELEASES_URL;
}

/** 解析 GitHub Releases API 响应体；若是草稿或预发布则不提取版本号 */
export function parseGithubReleasePayload(payload: unknown, checkedAt = Date.now()): UpdateState {
  if (typeof payload !== 'object' || payload == null) {
    return { checkedAt, lastError: '响应格式无效' };
  }
  const data = payload as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
  };
  if (data.draft === true || data.prerelease === true) {
    return { checkedAt };
  }
  const latestVersion = typeof data.tag_name === 'string' ? normalizeVersion(data.tag_name) : '';
  if (!latestVersion) {
    return { checkedAt, lastError: '未找到有效的版本号标签' };
  }
  return {
    checkedAt,
    latestVersion,
    releaseUrl: sanitizeReleaseUrl(data.html_url),
    ...(typeof data.published_at === 'string' ? { publishedAt: data.published_at } : {}),
  };
}
