/**
 * 例外主机匹配单测（情景模式 / 全局模式的例外站点）。
 * 覆盖：通配 '*.x' / '*'、精确主机、IPv4 CIDR 网段、IPv6 字面量、非法输入。
 */
import { describe, expect, it } from 'vitest';
import { hostMatches } from '../src/storage';

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
