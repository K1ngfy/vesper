/**
 * VESPER 品牌徽标定义：半阖之瞳（Veiled Eye），纯矢量几何路径。
 * 供 React UI（src/ui/VesperLogo.tsx）、content script Shadow DOM（src/content/ui.ts）
 * 及 background 注入提示共享；DOM 构造严格使用 createElementNS，兼容 Trusted Types CSP。
 */
export const VESPER_LOGO_VIEWBOX = '0 0 100 100';

export const VESPER_LOGO_PATHS = [
  'M 4 45.5 Q 50 -11.5 96 45.5 Z',
  'M 36.5 52.5 A 13.5 13.5 0 0 0 63.5 52.5 Z',
  'M 4 53 Q 50 113 96 53 L 81.5 53 Q 50 95 18.5 53 Z',
] as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 以零 innerHTML 方式创建内联 SVG 标志节点（兼容严格 Trusted Types 站点） */
export function createVesperLogoSvg(size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', VESPER_LOGO_VIEWBOX);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.display = 'inline-block';
  svg.style.flex = 'none';
  svg.style.verticalAlign = 'middle';
  for (const d of VESPER_LOGO_PATHS) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
