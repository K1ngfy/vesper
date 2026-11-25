import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  GITHUB_RELEASES_URL,
  hasAvailableUpdate,
  isNewerVersion,
  normalizeVersion,
  parseGithubReleasePayload,
  sanitizeReleaseUrl,
} from '../src/core/update';

describe('版本比较与 GitHub Release 解析', () => {
  it('normalizeVersion 支持前导 v/V 与构建元数据剥离，拒绝非法输入', () => {
    expect(normalizeVersion('v0.2.8')).toBe('0.2.8');
    expect(normalizeVersion('V1.10.2+20261125')).toBe('1.10.2');
    expect(normalizeVersion('0.3.0-rc.1')).toBe('0.3.0-rc.1');
    expect(normalizeVersion('')).toBe('');
    expect(normalizeVersion('latest')).toBe('');
  });

  it('compareVersions 与 isNewerVersion 正确处理多位数修订号与预发布后缀', () => {
    expect(isNewerVersion('0.2.7', '0.2.8')).toBe(true);
    expect(isNewerVersion('0.2.7', 'v0.2.10')).toBe(true);
    expect(isNewerVersion('0.2.10', '0.2.8')).toBe(false);
    expect(isNewerVersion('0.2.8', '0.2.8')).toBe(false);
    // 正式版高于同号预发布版
    expect(compareVersions('0.2.8', '0.2.8-rc.1')).toBe(1);
    expect(compareVersions('0.2.8-alpha.10', '0.2.8-alpha.2')).toBe(1);
  });

  it('hasAvailableUpdate 在升级到同版本或更高版本后自动熄灭红点', () => {
    const state = { checkedAt: 1000, latestVersion: '0.2.8' };
    expect(hasAvailableUpdate('0.2.7', state)).toBe(true);
    expect(hasAvailableUpdate('0.2.8', state)).toBe(false);
    expect(hasAvailableUpdate('0.3.0', state)).toBe(false);
    expect(hasAvailableUpdate('0.2.7', undefined)).toBe(false);
  });

  it('parseGithubReleasePayload 解析正式版并忽略 draft / prerelease', () => {
    const ok = parseGithubReleasePayload(
      {
        tag_name: 'v0.3.0',
        html_url: 'https://github.com/K1ngfy/vesper/releases/tag/v0.3.0',
        published_at: '2026-11-25T00:00:00Z',
        draft: false,
        prerelease: false,
      },
      12345,
    );
    expect(ok).toEqual({
      checkedAt: 12345,
      latestVersion: '0.3.0',
      releaseUrl: 'https://github.com/K1ngfy/vesper/releases/tag/v0.3.0',
      publishedAt: '2026-11-25T00:00:00Z',
    });

    const pre = parseGithubReleasePayload({ tag_name: 'v0.4.0-beta.1', prerelease: true }, 99);
    expect(pre.latestVersion).toBeUndefined();
    expect(hasAvailableUpdate('0.2.7', pre)).toBe(false);
  });

  it('sanitizeReleaseUrl 拦截外部或非 https 链接并回退到官方 Releases 页', () => {
    expect(sanitizeReleaseUrl('https://evil.example.com/K1ngfy/vesper')).toBe(GITHUB_RELEASES_URL);
    expect(sanitizeReleaseUrl('javascript:alert(1)')).toBe(GITHUB_RELEASES_URL);
    expect(sanitizeReleaseUrl('https://github.com/other/repo/releases/tag/v1.0.0')).toBe(
      GITHUB_RELEASES_URL,
    );
  });
});
