import { defineConfig } from 'vitest/config';

// 核心引擎为纯 TS，node 环境即可；不涉及浏览器 API
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
