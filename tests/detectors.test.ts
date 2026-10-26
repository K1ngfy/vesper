/**
 * 内置检测器单测（VESPEER.md 4.2：每个检测器至少 2 正例 + 2 反例）。
 * 直接对检测器正则断言，不经完整引擎。
 */
import { describe, expect, it } from 'vitest';
import { DETECTOR_LIST } from '../src/core/detectors';
import type { Detector } from '../src/core/types';

function matches(det: Detector, text: string): string[] {
  const out: string[] = [];
  for (const p of det.patterns) {
    const re = new RegExp(p.source, p.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[0]);
  }
  return out;
}

const CASES: Record<string, { positive: string[]; negative: string[] }> = {
  email: {
    positive: ['name@company.com', 'first.last+tag@sub.domain.cn'],
    negative: ['not-an-email', 'a@b（缺少顶级域）'],
  },
  phone_cn: {
    positive: ['13812345678', '138-1234-5678', '139 1234 5678'],
    negative: ['12345678901（第二位非 3-9）', '138123456789（12 位过长）'],
  },
  ipv4: {
    positive: ['10.0.3.15', '192.168.1.1'],
    negative: ['999.1.1.1（超范围）', '1.2.3（缺段）'],
  },
  openai_key: {
    positive: ['sk-abcdef1234567890', 'sk-proj-abcdef123456'],
    negative: ['sk-123（过短）', 'ask-proj-abcdefghijkl（前面粘连字母）'],
  },
  aws_ak: {
    positive: ['AKIAIOSFODNN7EXAMPLE', 'ASIA1234567890ABCDEF'],
    negative: ['AKIA123（过短）', 'akiaIOSFODNN7EXAMPLE（小写前缀）'],
  },
  github_token: {
    positive: [
      'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
      'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
    ],
    negative: ['ghp_short（过短）', 'ghx_aaaaaaaaaaaaaaaaaaaa（未知前缀）'],
  },
  jwt: {
    positive: [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ2ZXNwZXIifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ],
    negative: ['eyJabc（段数不足）', 'aaa.bbb.ccc（非 eyJ 开头）'],
  },
  private_key: {
    positive: [
      '-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBg==\n-----END PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    ],
    negative: [
      '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----（公钥不算）',
      '-----BEGIN PRIVATE KEY-----\nabc（无结束行）',
    ],
  },
  id_card_cn: {
    positive: ['11010119900307888X', '320311197006010011'],
    negative: ['110101199003077（17 位）', '1234567890123456789（19 位过长）'],
  },
  db_conn: {
    positive: ['password=secret123', 'postgres://user:passw0rd@10.0.0.1/db'],
    negative: ['username=foo（非密码键）', '普通文本没有连接串'],
  },
  bearer: {
    positive: ['Authorization: Bearer abc.def.ghi', 'authorization: bearer token123'],
    negative: ['Authorization: Basic xyz（非 Bearer）', 'Bearer 后面没有内容\n'],
  },
  generic_secret: {
    positive: ['api_key=abc123', 'secret: xyz789'],
    negative: ['monkey=abc（key 非独立词）', '今天天气不错'],
  },
};

describe('内置检测器（每器 2 正例 2 反例）', () => {
  for (const det of DETECTOR_LIST) {
    const c = CASES[det.id]!;
    it(`${det.id} ${det.name}：正例命中`, () => {
      for (const text of c.positive) {
        expect(matches(det, text).length, `应命中: ${text}`).toBeGreaterThan(0);
      }
    });
    it(`${det.id} ${det.name}：反例不命中`, () => {
      for (const text of c.negative) {
        expect(matches(det, text).length, `不应命中: ${text}`).toBe(0);
      }
    });
  }

  it('db_conn 部分替换只抹掉密码段', () => {
    const det = DETECTOR_LIST.find((d) => d.id === 'db_conn')!;
    const p = det.patterns[0]!;
    const re = new RegExp(p.source, p.flags);
    const out = 'password=secret123'.replace(re, (...args) =>
      (args[0] as string).replace(args[p.group!] as string, '***'),
    );
    expect(out).toBe('password=***');
  });

  it('bearer 部分替换只抹掉 token 段', () => {
    const det = DETECTOR_LIST.find((d) => d.id === 'bearer')!;
    const p = det.patterns[0]!;
    const re = new RegExp(p.source, p.flags);
    const out = 'Authorization: Bearer abc123'.replace(re, (...args) =>
      (args[0] as string).replace(args[p.group!] as string, '***'),
    );
    expect(out).toBe('Authorization: Bearer ***');
  });
});
