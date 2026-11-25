/**
 * 宿主页面 MAIN world 剪贴板守卫内容脚本（registration: 'runtime'，不进静态 manifest）。
 * 由 background 仅在「已启用且已获用户授权」的站点上以 document_start 动态注册，遵守 D5 最小权限。
 */
import { installClipboardGuard } from '@/src/content/clipboard-guard';

export default defineContentScript({
  registration: 'runtime',
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installClipboardGuard();
  },
});
