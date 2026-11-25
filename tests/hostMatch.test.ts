/**
 * 例外主机匹配单测（情景模式 / 全局模式的例外站点）。
 * 覆盖：通配 '*.x' / '*'、精确主机、IPv4 CIDR 网段、IPv6 字面量、非法输入。
 */
import { describe, expect, it } from 'vitest';
import {
  getRemovableOrigins,
  hostMatches,
  isValidHostPattern,
  validateImport,
} from '../src/storage';
import { createDefaultScheme } from '../src/core/presets';
import type { SiteRule } from '../src/core/types';

describe('hostMatches', () => {
  it('通配与子域', () => {
    expect(hostMatches('chatgpt.com', '*.chatgpt.com')).toBe(true);
    expect(hostMatches('chat.openai.com', '*.openai.com')).toBe(true);
    expect(hostMatches('openai.com', '*.openai.com')).toBe(true);
    expect(hostMatches('notopenai.com', '*.openai.com')).toBe(false);
    expect(hostMatches('anything.example.com', '*')).toBe(true);
  });

  it('精确主机与默认例外', () => {
    expect(hostMatches('localhost', 'localhost')).toBe(true);
    expect(hostMatches('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(hostMatches('127.0.0.2', '127.0.0.1')).toBe(false);
  });

  it('IPv4 CIDR 网段', () => {
    expect(hostMatches('192.168.1.20', '192.168.0.0/16')).toBe(true);
    expect(hostMatches('192.168.255.255', '192.168.0.0/16')).toBe(true);
    expect(hostMatches('192.169.0.1', '192.168.0.0/16')).toBe(false);
    expect(hostMatches('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(hostMatches('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(hostMatches('127.0.0.1', '127.0.0.1/32')).toBe(true);
    expect(hostMatches('127.0.0.2', '127.0.0.1/32')).toBe(false);
    // /0 覆盖全部 IPv4，但仍不匹配域名
    expect(hostMatches('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(hostMatches('example.com', '0.0.0.0/0')).toBe(false);
    // 非法网段：不命中而不是抛错
    expect(hostMatches('192.168.1.1', '192.168.0.0/33')).toBe(false);
    expect(hostMatches('192.168.1.1', '192.168.0.0/abc')).toBe(false);
  });

  it('IPv6 字面量（URL.hostname 带方括号）', () => {
    expect(hostMatches('[::1]', '[::1]')).toBe(true);
    expect(hostMatches('[::1]', '::1')).toBe(true);
    expect(hostMatches('::1', '[::1]')).toBe(true);
    expect(hostMatches('[::2]', '[::1]')).toBe(false);
  });

  it('空值与异常输入', () => {
    expect(hostMatches('', 'localhost')).toBe(false);
    expect(hostMatches('localhost', '')).toBe(false);
    expect(hostMatches('EXAMPLE.COM', 'example.com')).toBe(true);
  });
});

describe('isValidHostPattern', () => {
  it('接受合法域名、通配、localhost、IPv4 与 IPv6 字面量', () => {
    expect(isValidHostPattern('chatgpt.com')).toBe(true);
    expect(isValidHostPattern('*.chatgpt.com')).toBe(true);
    expect(isValidHostPattern('example.com.')).toBe(true);
    expect(isValidHostPattern('*')).toBe(true);
    expect(isValidHostPattern('localhost')).toBe(true);
    expect(isValidHostPattern('192.168.1.1')).toBe(true);
    expect(isValidHostPattern('[::1]')).toBe(true);
  });

  it('拒绝非法数值 TLD、伪造 IPv4、非法 IPv6 与含协议路径输入', () => {
    expect(isValidHostPattern('999.999.999.999')).toBe(false);
    expect(isValidHostPattern('foo.123')).toBe(false);
    expect(isValidHostPattern('[:]')).toBe(false);
    expect(isValidHostPattern('[:::]')).toBe(false);
    expect(isValidHostPattern('https://chatgpt.com')).toBe(false);
    expect(isValidHostPattern('chatgpt.com/chat')).toBe(false);
  });
});

describe('getRemovableOrigins', () => {
  const site = (id: string, host: string, enabled: boolean): SiteRule => ({
    id,
    host,
    schemeId: '',
    enabled,
    mode: 'preview',
  });

  it('父级通配域名仍启用时不误撤销子域权限', () => {
    const gemini = site('1', '*.gemini.google.com', true);
    const google = site('2', '*.google.com', true);
    expect(getRemovableOrigins([gemini], [google], 'list')).toEqual([]);
  });

  it('无父级或同域启用站点时正常返回待回收 origins', () => {
    const gemini = site('1', '*.gemini.google.com', true);
    const claude = site('2', '*.claude.ai', true);
    expect(getRemovableOrigins([gemini], [claude], 'list')).toEqual([
      '*://gemini.google.com/*',
      '*://*.gemini.google.com/*',
    ]);
  });
});

describe('validateImport', () => {
  const baseBundle = () => ({
    app: 'vesper' as const,
    schemaVersion: 8,
    exportedAt: 0,
    schemes: [createDefaultScheme()],
    sites: [
      {
        id: 's1',
        host: '*.chatgpt.com',
        schemeId: '',
        enabled: true,
        mode: 'preview' as const,
        category: 'ai' as const,
      },
    ],
    settings: {
      globalEnabled: true,
      activeSchemeId: '',
      persistMappings: false,
      siteScope: 'list' as const,
      globalMode: 'preview' as const,
      excludeHosts: ['localhost'],
    },
  });

  it('拒绝空方案数组与非法站点分类', () => {
    const emptySchemes = baseBundle();
    emptySchemes.schemes = [];
    expect(validateImport(emptySchemes)).toBe('缺少方案列表');

    const badCategory = baseBundle();
    (badCategory.sites[0] as unknown as { category: string }).category = 'unknown';
    expect(validateImport(badCategory)).toBe('站点结构不合法');
  });

  it('兼容 v2 旧版备份的 matchPattern 站点格式', () => {
    const legacy = {
      ...baseBundle(),
      schemaVersion: 2,
      sites: [
        {
          id: 's_legacy',
          matchPattern: '*://*.chatgpt.com/*',
          schemeId: '',
          enabled: true,
          mode: 'preview',
        },
      ],
    };
    expect(validateImport(legacy)).toBeNull();
  });
});
