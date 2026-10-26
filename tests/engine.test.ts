/**
 * 引擎单测（VESPEER.md 第 9 节 fixture 必须全过）。
 */
import { describe, expect, it } from 'vitest';
import { desensitize, maskValue, testRule } from '../src/core/engine';
import { restore } from '../src/core/restore';
import { DETECTORS } from '../src/core/detectors';
import type { BuiltinDetectorId, Rule, Scheme } from '../src/core/types';

const FIXTURE_INPUT = `联系张三（zhangsan@acme-tech.com，13812345678），
服务器 10.0.3.15 上的服务报错，key=sk-proj-abcdef123456，
张三的邮箱还是 zhangsan@acme-tech.com。`;

function builtinRule(id: BuiltinDetectorId): Rule {
  const det = DETECTORS[id];
  return {
    id: `r_${id}`,
    type: 'builtin',
    enabled: true,
    name: det.name,
    pattern: det.id,
    replacement: det.defaultReplacement,
    mode: 'numbered',
  };
}

/** 文档 fixture 方案：builtin email/phone/ipv4/openai_key 开启，numbered 模式 */
function fixtureScheme(): Scheme {
  return {
    id: 's_fixture',
    name: 'fixture',
    isDefault: true,
    enabled: true,
    rules: ['email', 'phone_cn', 'ipv4', 'openai_key'].map((id) =>
      builtinRule(id as BuiltinDetectorId),
    ),
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('文档第 9 节 fixture', () => {
  it('两处同一邮箱得到同一编号，各检测器命中正确，hits=5', () => {
    const res = desensitize(FIXTURE_INPUT, fixtureScheme());
    expect(res.hits.length).toBe(5);

    // 同值一致：两处邮箱同为 [EMAIL_1]
    const emailHits = res.hits.filter((h) => h.ruleId === 'r_email');
    expect(emailHits.length).toBe(2);
    expect(emailHits[0]!.replaced).toBe('[EMAIL_1]');
    expect(emailHits[1]!.replaced).toBe('[EMAIL_1]');

    expect(res.output).toContain('[PHONE_1]');
    expect(res.output).toContain('[IP_1]');
    expect(res.output).toContain('[API_KEY_1]');

    // 普通中文不误伤
    expect(res.output).toContain('联系张三（');
    expect(res.output).toContain('上的服务报错');

    // 占位符不被二次替换：输出中不再有原始敏感值
    expect(res.output).not.toContain('zhangsan@acme-tech.com');
    expect(res.output).not.toContain('13812345678');
    expect(res.output).not.toContain('sk-proj-abcdef123456');

    // 映射可用于还原
    expect(res.mapping['[EMAIL_1]']).toBe('zhangsan@acme-tech.com');
    expect(res.mapping['[PHONE_1]']).toBe('13812345678');
  });

  it('restore 往返一致', () => {
    const res = desensitize(FIXTURE_INPUT, fixtureScheme());
    expect(restore(res.output, res.mapping)).toBe(FIXTURE_INPUT);
  });
});

describe('引擎通用行为', () => {
  it('空文本原样返回', () => {
    const res = desensitize('', fixtureScheme());
    expect(res.output).toBe('');
    expect(res.hits).toEqual([]);
  });

  it('纯英文无命中不干预', () => {
    const res = desensitize('hello world, nothing sensitive here.', fixtureScheme());
    expect(res.output).toBe('hello world, nothing sensitive here.');
    expect(res.hits.length).toBe(0);
  });

  it('停用规则不生效', () => {
    const scheme = fixtureScheme();
    scheme.rules[0]!.enabled = false; // 关掉 email
    const res = desensitize(FIXTURE_INPUT, scheme);
    expect(res.output).toContain('zhangsan@acme-tech.com');
  });

  it('方案整体停用时直接放行', () => {
    const scheme = { ...fixtureScheme(), enabled: false };
    const res = desensitize(FIXTURE_INPUT, scheme);
    expect(res.output).toBe(FIXTURE_INPUT);
  });

  it('非法正则被拦（testRule 抛错）', () => {
    const bad: Rule = {
      id: 'bad',
      type: 'regex',
      enabled: true,
      name: 'bad',
      pattern: '([a-z',
      replacement: 'x',
      mode: 'fixed',
    };
    expect(() => testRule('sample', bad)).toThrow();
  });

  it('desensitize 对非法正则兜底跳过、不中断', () => {
    const scheme = fixtureScheme();
    scheme.rules.unshift({
      id: 'bad',
      type: 'regex',
      enabled: true,
      name: 'bad',
      pattern: '([a-z',
      replacement: 'x',
      mode: 'fixed',
    });
    const res = desensitize(FIXTURE_INPUT, scheme);
    expect(res.hits.length).toBe(5);
  });

  it('keyword 规则：大小写不敏感 + 全词匹配', () => {
    const rule: Rule = {
      id: 'k1',
      type: 'keyword',
      enabled: true,
      name: '公司名',
      pattern: 'acme',
      replacement: '星辰科技',
      mode: 'fixed',
      wholeWord: true,
    };
    const res = testRule('ACME corp, xacme, acmex, acme', rule);
    // 全词（标准 \b 语义）：xacme/acmex 中粘连字母数字的不匹配；独立的两个 acme 被替换
    expect(res.output).toBe('星辰科技 corp, xacme, acmex, 星辰科技');
  });

  it('regex 规则：捕获组模板 $1', () => {
    const rule: Rule = {
      id: 'r1',
      type: 'regex',
      enabled: true,
      name: '工号',
      pattern: '工号(\\d+)',
      replacement: '工号***',
      mode: 'fixed',
      regexFlags: 'g',
    };
    const res = testRule('工号12345 和 工号999', rule);
    expect(res.output).toBe('工号*** 和 工号***');
  });

  it('numbered：不同值递增编号，同值复用', () => {
    const res = desensitize('a@x.com b@x.com a@x.com', {
      ...fixtureScheme(),
      rules: [builtinRule('email')],
    });
    expect(res.output).toBe('[EMAIL_1] [EMAIL_2] [EMAIL_1]');
    expect(Object.keys(res.mapping).length).toBe(2);
  });

  it('防二次替换：占位符文本不会被后续 keyword 规则吃掉', () => {
    const scheme: Scheme = {
      ...fixtureScheme(),
      rules: [
        builtinRule('email'),
        {
          id: 'k2',
          type: 'keyword',
          enabled: true,
          name: '误伤测试',
          pattern: 'EMAIL_1',
          replacement: 'XXX',
          mode: 'fixed',
        },
      ],
    };
    const res = desensitize('mail: a@x.com', scheme);
    expect(res.output).toBe('mail: [EMAIL_1]');
  });

  it('宽泛规则不包住具体规则的替换产物', () => {
    // generic_secret 在 openai_key 之后执行，不得二次处理已替换的 key
    const scheme: Scheme = {
      ...fixtureScheme(),
      rules: [builtinRule('openai_key'), builtinRule('generic_secret')],
    };
    const res = desensitize('key=sk-proj-abcdef123456', scheme);
    expect(res.output).toBe('key=[API_KEY_1]');
    expect(res.hits.length).toBe(1);
  });

  it('mask 模式输出格式且不可逆（不入映射）', () => {
    const rule = builtinRule('phone_cn');
    rule.mode = 'mask';
    rule.maskKeep = { head: 3, tail: 4 };
    const res = testRule('电话 13812345678 完毕', rule);
    expect(res.output).toBe('电话 138****5678 完毕');
    expect(Object.keys(res.mapping).length).toBe(0);
  });

  it('maskValue：邮箱保留域名', () => {
    // 本地部分 zhangsan 隐藏 6 位 → 6 个星号，域名完整保留
    expect(maskValue('zhangsan@acme.com', { head: 1, tail: 1 }, true)).toBe('z******n@acme.com');
  });

  it('fixed 模式同替换文本对应多原值时视为不可逆', () => {
    const scheme: Scheme = {
      ...fixtureScheme(),
      rules: [
        {
          id: 'k3',
          type: 'keyword',
          enabled: true,
          name: '人名',
          pattern: '张三',
          replacement: '某人',
          mode: 'fixed',
        },
        {
          id: 'k4',
          type: 'keyword',
          enabled: true,
          name: '人名2',
          pattern: '李四',
          replacement: '某人',
          mode: 'fixed',
        },
      ],
    };
    const res = desensitize('张三和李四', scheme);
    expect(res.output).toBe('某人和某人');
    expect(res.mapping['某人']).toBeUndefined();
  });

  it('性能基线：100KB 文本 + 默认多规则 < 100ms', () => {
    const big = FIXTURE_INPUT.repeat(3000); // ~450KB 级文本
    const res = desensitize(big, fixtureScheme());
    expect(res.durationMs).toBeLessThan(100);
  });
});
