/**
 * icons.js — 线性图标集（SF Symbols 风格）
 *
 * 统一规格：24×24 viewBox、1.8 描边、圆头圆角、currentColor。
 * 全部为路径级 SVG，避免 emoji 在不同平台上的风格漂移。
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * 图标路径表。值为 `[d, opts?]`，opts.fill 表示实心图标。
 * @type {Record<string, [string, {fill?:boolean, extra?:string}] | [string[]]>}
 */
const PATHS = {
  // 导航 / 通用
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  chevronUp: 'M5 15l7-7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M4.5 12.5l5 5 10-11',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  moreVertical: 'M12 6h.01M12 12h.01M12 18h.01',

  // 功能
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.2-4.2',
  settings: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM19.4 15a1.6 1.6 0 00.32 1.77l.06.06a1.94 1.94 0 11-2.75 2.75l-.06-.06a1.6 1.6 0 00-1.77-.32 1.6 1.6 0 00-.97 1.47V21a1.94 1.94 0 11-3.88 0v-.1a1.6 1.6 0 00-1.05-1.47 1.6 1.6 0 00-1.77.32l-.06.06a1.94 1.94 0 11-2.75-2.75l.06-.06a1.6 1.6 0 00.32-1.77 1.6 1.6 0 00-1.47-.97H3a1.94 1.94 0 110-3.88h.1a1.6 1.6 0 001.47-1.05 1.6 1.6 0 00-.32-1.77l-.06-.06a1.94 1.94 0 112.75-2.75l.06.06a1.6 1.6 0 001.77.32H9a1.6 1.6 0 00.97-1.47V3a1.94 1.94 0 113.88 0v.1a1.6 1.6 0 00.97 1.47 1.6 1.6 0 001.77-.32l.06-.06a1.94 1.94 0 112.75 2.75l-.06.06a1.6 1.6 0 00-.32 1.77V9a1.6 1.6 0 001.47.97H21a1.94 1.94 0 110 3.88h-.1a1.6 1.6 0 00-1.5 1.15z',
  memory: 'M12 3a4 4 0 00-4 4v.3A3.7 3.7 0 005.6 11a3.7 3.7 0 001 6.5V18a3 3 0 003 3h1V3h-1.6zM15 3h1a3 3 0 013 3v.3a3.7 3.7 0 012.5 3.6c0 1.4-.8 2.7-2 3.3a3.7 3.7 0 01-1 6.5V21h-3.5z',
  book: 'M4 5.5A2.5 2.5 0 016.5 3H19v18H6.5A2.5 2.5 0 004 23V5.5zM4 5.5V19M19 3v18',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z',
  send: 'M12 20V5M12 5l-6.5 6.5M12 5l6.5 6.5',
  stop: 'M8 8h8v8H8z',
  image: 'M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5v-11zM4 16l4.5-4.5L13 16M14 13.5l2.5-2.5L20 14.5M15.5 8.5h.01',
  paperclip: 'M20 11.5l-8.4 8.4a5 5 0 01-7.1-7.1l8.5-8.5a3.4 3.4 0 014.8 4.8l-8.5 8.5a1.8 1.8 0 01-2.5-2.5l7.8-7.8',
  copy: 'M9 9V6.5A2.5 2.5 0 0111.5 4h6A2.5 2.5 0 0120 6.5v6a2.5 2.5 0 01-2.5 2.5H15M6.5 9h6A2.5 2.5 0 0115 11.5v6A2.5 2.5 0 0112.5 20h-6A2.5 2.5 0 014 17.5v-6A2.5 2.5 0 016.5 9z',
  trash: 'M4 7h16M9.5 7V5.5A1.5 1.5 0 0111 4h2a1.5 1.5 0 011.5 1.5V7M6.5 7l.8 12.1a2 2 0 002 1.9h5.4a2 2 0 002-1.9L17.5 7',
  edit: 'M4 20h4l10-10a2.8 2.8 0 10-4-4L4 16v4zM14.5 5.5l4 4',
  rewind: 'M4 12a8 8 0 108-8M4 4v5h5',
  download: 'M12 4v11M12 15l-4.5-4.5M12 15l4.5-4.5M5 19h14',
  pin: 'M12 17v4M9 4h6l-1 7 3.5 3H6.5L10 11 9 4z',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5',
  compass: 'M12 21a9 9 0 100-18 9 9 0 000 18zM15.5 8.5l-2 6-6 2 2-6 6-2z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20.5c1.2-3.4 4-5.5 7.5-5.5s6.3 2.1 7.5 5.5',
  users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20c.9-3.2 3.4-5.2 6.5-5.2s5.6 2 6.5 5.2M16 4.5a3.5 3.5 0 010 7M17.5 15c2.2.5 3.7 2.2 4 5',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3.5 12h17M12 3a14 14 0 010 18 14 14 0 010-18z',
  scroll: 'M6 4h11a2 2 0 012 2v12a2 2 0 002 2H7a2 2 0 01-2-2V6a2 2 0 011-1.7M5 18a2 2 0 002 2h9M9 8h7M9 12h7',
  key: 'M14.5 9.5a4.5 4.5 0 10-4 4.4L4 20.5V17h3v-3h2l1.6-1.6a4.5 4.5 0 003.9-2.9z',
  flag: 'M5 21V4M5 4h11l-1.5 4L16 12H5',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
  lightbulb: 'M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.5.4.8 1 .8 1.6V17h5.4v-1.5c0-.6.3-1.2.8-1.6A6 6 0 0012 3z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7.5V12l3 2',
  mapPin: 'M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11zM12 13a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  palette: 'M12 21a9 9 0 110-18c4.9 0 9 3.6 9 8 0 2.2-1.8 4-4 4h-2a2 2 0 00-1.4 3.4c.4.4.4 1.1 0 1.6-.4.6-1 1-1.6 1zM7.5 11h.01M10 7.5h.01M14 7.5h.01M16.5 11h.01',
  moon: 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z',
  sun: 'M12 16.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4',
  history: 'M3.5 12a8.5 8.5 0 1017 0 8.5 8.5 0 00-17 0zM12 7.5V12l3 2',
  sliders: 'M5 7h9M18 7h1M5 17h1M10 17h9M16 4v6M8 14v6',
  expand: 'M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5',
  mic: 'M12 15a3.5 3.5 0 003.5-3.5v-5a3.5 3.5 0 10-7 0v5A3.5 3.5 0 0012 15zM5.5 11.5a6.5 6.5 0 0013 0M12 18v3',
  file: 'M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9l-6-6zM13 3v6h6',
  play: 'M7 4.5l12 7.5-12 7.5v-15z',
  refresh: 'M20 12a8 8 0 11-2.3-5.6M20 4v5h-5',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  warn: 'M12 4l9 16H3l9-16zM12 10v4M12 17h.01',
  sidebar: 'M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5v-11zM9.5 4v16',
  arrowUp: 'M12 19V5M12 5l-6 6M12 5l6 6',
  jar: 'M8 3h8v3H8zM7 9.5A2.5 2.5 0 019.5 7h5A2.5 2.5 0 0117 9.5v9A2.5 2.5 0 0114.5 21h-5A2.5 2.5 0 017 18.5v-9zM10 11h4',
  wand: 'M15 4l1.2 3.3L19.5 8.5l-3.3 1.2L15 13l-1.2-3.3L10.5 8.5l3.3-1.2L15 4zM4 20L13.5 10.5M6.5 4.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7z',
};

/**
 * 生成 SVG 图标元素。
 * @param {string} name 图标名
 * @param {{size?:number, stroke?:number, fill?:boolean, className?:string}} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, opts = {}) {
  const { size = 20, stroke = 1.8, fill = false, className = '' } = opts;
  const def = PATHS[name] || PATHS.info;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  svg.style.display = 'block';
  const d = Array.isArray(def) ? def[0] : def;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  if (fill) {
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('stroke', 'none');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(stroke));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.appendChild(path);
  return svg;
}

/** 图标查询入口：icon('user', {size: 13}) */
export default { icon };
