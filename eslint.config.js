// ESLint flat config（VESPER）
// 侧重类型安全与一致性，风格交给 Prettier；规则尽量宽松避免噪音。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.output/**', '.wxt/**', 'test-results/**', 'e2e/test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // tsc 已有 noUncheckedIndexedAccess 等严格检查，未用变量交由 IDE 提示
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off',
      'prefer-const': 'warn',
    },
  },
  {
    // 测试与 E2E 放宽
    files: ['tests/**/*', 'e2e/tests/**/*'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Playwright fixture 第一参数必须是解构对象，空解构 {} 合理，不报错
      '@typescript-eslint/no-empty-pattern': 'off',
      'no-empty-pattern': 'off',
    },
  },
  prettier,
);
