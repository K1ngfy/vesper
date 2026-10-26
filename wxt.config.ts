import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * VESPER 工程配置（VESPEER.md 第 6/7 节）。
 *
 * 权限说明（备商店审核，逐项有用途）：
 * - storage：保存用户方案/站点/设置到 chrome.storage.local（D4，不用 sync）。
 * - contextMenus：右键"用 VESPER 脱敏选中文本"。
 * - sidePanel：侧边栏形态的工作台。
 * - scripting：按"已启用且已授权"的站点动态注册 content script（D5 最小权限的
 *   实现手段；文档第 7 节未列出，属文档未覆盖细节，按最小权限原则补充）。
 * - activeTab：Popup 显示"当前标签页站点拦截状态"时读取活动标签 URL。
 * - optional_host_permissions（全主机通配）：用户添加站点时按域名逐个申请，
 *   默认不申请任何主机权限（D5）。
 *
 * 禁止项（文档第 7 节）：tabs 全量、webRequest、clipboardRead、默认远程主机权限。
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'VESPER',
    description:
      '粘贴之前，先过一遍暮星。在文本进入 AI 平台前，于本机完成敏感信息脱敏。零服务器、零上传、零统计。',
    permissions: ['storage', 'contextMenus', 'sidePanel', 'scripting', 'activeTab'],
    optional_host_permissions: ['*://*/*'],
    commands: {
      'open-workbench': {
        suggested_key: { default: 'Ctrl+Shift+M', mac: 'Command+Shift+M' },
        description: '打开 VESPER 工作台',
      },
    },
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
  },
});
