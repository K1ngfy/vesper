import { defineConfig } from '@playwright/test';

/**
 * E2E 配置。
 * 注意（实测踩坑）：
 * - 不要在这里配 channel: 'chrome' —— 品牌 Chrome 137+ 屏蔽 --load-extension，
 *   且该配置会污染 spec 内 launchPersistentContext 的启动参数。
 * - 扩展加载由 load.spec.ts 的 worker fixture 用 launchPersistentContext 自管；
 *   intercept.spec.ts 用 chrome API 桩注入真实 content.js，不需要加载扩展。
 * - headless 模式不支持扩展，必须 headless: false（CI 上用 xvfb-run）。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  // 粘贴用例通过 navigator.clipboard 写真实系统剪贴板，多 worker 并行会互相覆盖，
  // 偶发读到别的用例的文本；串行执行可根治该串扰。
  workers: 1,
  use: {
    headless: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
