/**
 * 内置检测器注册表（VESPEER.md 4.2，共 12 个）。
 * 正则集中维护在本文件，便于审计与站点无关性验证。
 *
 * 设计要点：
 * - 每个检测器可含多条 pattern；`group` 表示"只替换该捕获组"（部分替换），
 *   用于 db_conn / bearer / generic_secret 这类只需抹掉值、保留上下文的场景。
 * - 所有正则均在 value 字符类中排除 \uE000/\uE001（引擎内部令牌），
 *   与引擎的"含令牌即跳过"双保险，杜绝二次替换。
 * - 检测器只做模式匹配，不做联网校验、不验证校验码（文档：宽松匹配即可）。
 */
import type { Detector, BuiltinDetectorId } from './types';

export const DETECTORS: Record<BuiltinDetectorId, Detector> = {
  email: {
    id: 'email',
    name: '邮箱',
    description: '识别 name@company.com 形式的邮箱地址',
    patterns: [{ source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'g' }],
    defaultReplacement: '[EMAIL_n]',
  },

  phone_cn: {
    id: 'phone_cn',
    name: '中国手机号',
    description: '1 开头的 11 位手机号，支持空格/连字符分隔',
    // 前后断言防止误匹配更长数字串（如 18 位身份证号）的片段
    patterns: [{ source: '(?<!\\d)1[3-9]\\d[\\s-]?\\d{4}[\\s-]?\\d{4}(?!\\d)', flags: 'g' }],
    defaultReplacement: '[PHONE_n]',
  },

  ipv4: {
    id: 'ipv4',
    name: 'IPv4 地址',
    description: '点分十进制 IPv4，含 0-255 范围约束',
    patterns: [
      {
        source:
          '(?<![\\d.])(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}(?![\\d.])',
        flags: 'g',
      },
    ],
    defaultReplacement: '[IP_n]',
  },

  openai_key: {
    id: 'openai_key',
    name: 'OpenAI 风格 Key',
    description: 'sk-... / sk-proj-... 形式的 API Key',
    patterns: [{ source: '\\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\\b', flags: 'g' }],
    defaultReplacement: '[API_KEY_n]',
  },

  aws_ak: {
    id: 'aws_ak',
    name: 'AWS Access Key',
    description: 'AKIA/ASIA 开头 + 16 位大写字母数字',
    patterns: [{ source: '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b', flags: 'g' }],
    defaultReplacement: '[AWS_KEY_n]',
  },

  github_token: {
    id: 'github_token',
    name: 'GitHub Token',
    description: 'ghp_/gho_ 等经典 Token 与 github_pat_ 细粒度 Token',
    patterns: [
      {
        source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\\b|\\bgithub_pat_[A-Za-z0-9_]{16,}\\b',
        flags: 'g',
      },
    ],
    defaultReplacement: '[TOKEN_n]',
  },

  jwt: {
    id: 'jwt',
    name: 'JWT',
    description: 'eyJ 开头的三段式 JSON Web Token',
    patterns: [
      {
        source: '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}\\b',
        flags: 'g',
      },
    ],
    defaultReplacement: '[JWT_n]',
  },

  private_key: {
    id: 'private_key',
    name: '私钥块',
    description: '-----BEGIN ... PRIVATE KEY----- 整块（含多行）',
    patterns: [
      {
        source:
          '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----',
        flags: 'g',
      },
    ],
    defaultReplacement: '[PRIVATE_KEY]',
  },

  id_card_cn: {
    id: 'id_card_cn',
    name: '中国身份证号',
    description: '18 位身份证号（末位可为 X），宽松匹配不校验校验码',
    patterns: [{ source: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', flags: 'g' }],
    defaultReplacement: '[ID_n]',
  },

  db_conn: {
    id: 'db_conn',
    name: '连接串密码',
    description: 'password=... 与 ://user:pass@host 中的密码段（仅替换密码）',
    patterns: [
      // key=value 形式：仅替换值（第 3 组），保留键与引号
      {
        source: '(password\\s*[=:]\\s*)([\'"]?)([^\\s\'";\\uE000\\uE001]+)\\2',
        flags: 'gi',
        group: 3,
      },
      // URL 形式：仅替换 user:pass@ 中的 pass（第 2 组）
      {
        source: '(://[^:\\s/@]+:)([^@\\s\\uE000\\uE001]+)(@)',
        flags: 'g',
        group: 2,
      },
    ],
    defaultReplacement: '[PASSWORD_n]',
  },

  bearer: {
    id: 'bearer',
    name: 'Bearer Token',
    description: 'Authorization: Bearer ... 的 token 段（仅替换 token）',
    patterns: [
      {
        source: '(Authorization\\s*:\\s*Bearer\\s+)([A-Za-z0-9._~+/=\\-]+)',
        flags: 'gi',
        group: 2,
      },
    ],
    defaultReplacement: '[TOKEN_n]',
  },

  generic_secret: {
    id: 'generic_secret',
    name: '通用密钥赋值',
    description: 'api_key|secret|token|passwd 等键的值部分（仅替换值）',
    // 注意：按文档定义不含裸 "key"，避免与 openai_key 等具体检测器冲突；
    // 值字符类排除内部令牌字符，防止包住已替换产物。
    patterns: [
      {
        source:
          '\\b(api[_-]?key|secret|token|passwd|password|pwd)\\b(\\s*[:=]\\s*)([\'"]?)([^\\s\'",;\\uE000\\uE001]+)\\3',
        flags: 'gi',
        group: 4,
      },
    ],
    defaultReplacement: '[SECRET_n]',
  },
};

export const DETECTOR_LIST: Detector[] = Object.values(DETECTORS);

export function getDetector(id: string): Detector | undefined {
  return (DETECTORS as Record<string, Detector>)[id];
}
