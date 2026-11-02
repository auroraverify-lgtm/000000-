/**
 * Собственный набор SVG-иконок (24×24, штриховые, скруглённые).
 * Все иконки наследуют цвет через currentColor — единый стиль во всём приложении.
 */
const S = (path, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}${extra}</svg>`;

export const icons = {
  // Бренд
  logo: `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="lg1" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
        <stop stop-color="var(--accent)"/><stop offset=".55" stop-color="var(--accent-2)"/><stop offset="1" stop-color="var(--accent-3)"/>
      </linearGradient>
      <linearGradient id="lg2" x1="8" y1="40" x2="40" y2="8" gradientUnits="userSpaceOnUse">
        <stop stop-color="#ffffff" stop-opacity=".95"/><stop offset="1" stop-color="#ffffff" stop-opacity=".55"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="14" fill="url(#lg1)"/>
    <path d="M14 30c3.4-9.4 6.8-12.2 9-12.2 2.1 0 3.1 2.2 5.2 6.6 1 2.2 1.9 3.2 2.8 3.2 1.3 0 2.3-1.3 3-3.6" stroke="url(#lg2)" stroke-width="3.1" stroke-linecap="round" fill="none"/>
    <circle cx="33.5" cy="16.5" r="2.4" fill="#fff" fill-opacity=".92"/>
  </svg>`,

  // Навигация
  chats: S('<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.9 8.9 0 0 1-3.8-.8L4 20.5l1.5-4.3A8.3 8.3 0 0 1 4.5 11.5 8.4 8.4 0 0 1 13 3.1a8.4 8.4 0 0 1 8 8.4Z"/><path d="M9 11.5h8M9 8.4h5"/>'),
  search: S('<circle cx="11" cy="11" r="6.4"/><path d="m16 16 4.2 4.2"/>'),
  settings: S('<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1A1.7 1.7 0 0 0 10.13 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: S('<path d="M15 19l-7-7 7-7"/>'),
  chevronRight: S('<path d="M9 5l7 7-7 7"/>'),
  chevronDown: S('<path d="M5 9l7 7 7-7"/>'),
  arrowDown: S('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  more: S('<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>'),
  send: S('<path d="M4.5 12 20 4.5l-4.2 15.6-4.1-5.4-7.2-2.7Z"/><path d="m11.7 14.7 8.3-10.2"/>'),
  paperclip: S('<path d="M20.4 11.3 12.2 19.5a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7-7"/>'),
  mic: S('<rect x="9.2" y="3" width="5.6" height="10.4" rx="2.8"/><path d="M5.5 11.4a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/><path d="M9 21h6"/>'),
  smile: S('<circle cx="12" cy="12" r="8.6"/><path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0"/><path d="M9.4 9.6h.01M14.6 9.6h.01"/>'),
  sticker: S('<path d="M14.6 3.4H7a3.6 3.6 0 0 0-3.6 3.6v10a3.6 3.6 0 0 0 3.6 3.6h6.6a6 6 0 0 0 7-7V9.8Z"/><path d="M13.6 20.4V15a2.4 2.4 0 0 1 2.4-2.4h4.4"/>'),
  image: S('<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="3.4"/><circle cx="9" cy="10" r="1.9"/><path d="m4 17 4.6-4.3a2.4 2.4 0 0 1 3.3.1l3.4 3.4a2.4 2.4 0 0 0 3.4-.1l2-2"/>'),
  video: S('<rect x="2.8" y="5.6" width="13.4" height="12.8" rx="3.2"/><path d="m16.2 12 5-3.4v10.8l-5-3.4Z"/>'),
  file: S('<path d="M13.4 3.2H7.6A3.2 3.2 0 0 0 4.4 6.4v11.2a3.2 3.2 0 0 0 3.2 3.2h8.8a3.2 3.2 0 0 0 3.2-3.2V9.2Z"/><path d="M13.4 3.2v4.2a1.8 1.8 0 0 0 1.8 1.8h4.4"/>'),
  camera: S('<path d="M4.6 8.4h2.7l1.4-2.4h6.6l1.4 2.4h2.7a1.8 1.8 0 0 1 1.8 1.8v7a1.8 1.8 0 0 1-1.8 1.8H4.6a1.8 1.8 0 0 1-1.8-1.8v-7a1.8 1.8 0 0 1 1.8-1.8Z"/><circle cx="12" cy="13.3" r="3.3"/>'),
  check: S('<path d="M4.5 12.6 9.5 17.5 19.5 6.5"/>'),
  doubleCheck: S('<path d="M2 13.2 6.4 17.5 15 8.6"/><path d="M9.6 13.6 13.6 17.5 22 8.8"/>'),
  clock: S('<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 1.9"/>'),
  alert: S('<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5M12 16h.01"/>'),
  trash: S('<path d="M4.8 7h14.4M9.6 7V5.4A1.4 1.4 0 0 1 11 4h2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.4 7l.9 11.4a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.6 7"/><path d="M10.4 11v5.4M13.6 11v5.4"/>'),
  edit: S('<path d="M16.5 3.9a2.2 2.2 0 0 1 3.1 3.1L8.4 18.2l-4.1 1 1-4.1Z"/><path d="m14.6 5.8 3.6 3.6"/>'),
  reply: S('<path d="M8.6 10.4 4 15l4.6 4.6"/><path d="M4 15h9.4a6.6 6.6 0 0 0 6.6-6.6V5"/>'),
  forward: S('<path d="M15.4 10.4 20 15l-4.6 4.6"/><path d="M20 15h-9.4A6.6 6.6 0 0 1 4 8.4V5"/>'),
  copy: S('<rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2.6"/><path d="M15.4 5.4A2.4 2.4 0 0 0 13 3H6a2.6 2.6 0 0 0-2.6 2.6V13A2.4 2.4 0 0 0 5.4 15.4"/>'),
  pin: S('<path d="M9.2 3.6h5.6l-.7 5.1 3 3.3H6.9l3-3.3Z"/><path d="M12 12v8.4"/>'),
  unpin: S('<path d="M9.2 3.6h5.6l-.7 5.1 3 3.3H6.9l3-3.3Z"/><path d="M12 12v8.4"/><path d="M4 20 20 4"/>'),
  users: S('<circle cx="9.2" cy="8.6" r="3.6"/><path d="M2.8 20a6.4 6.4 0 0 1 12.8 0"/><path d="M16.4 5.6a3.4 3.4 0 0 1 0 6.6"/><path d="M18.2 20a6 6 0 0 0-2-4.2"/>'),
  user: S('<circle cx="12" cy="8.4" r="4"/><path d="M4.4 20.4a7.6 7.6 0 0 1 15.2 0"/>'),
  userPlus: S('<circle cx="9.6" cy="8.6" r="3.6"/><path d="M3.2 20a6.4 6.4 0 0 1 12.8 0"/><path d="M18.4 7.6v5.2M15.8 10.2h5.2"/>'),
  userMinus: S('<circle cx="9.6" cy="8.6" r="3.6"/><path d="M3.2 20a6.4 6.4 0 0 1 12.8 0"/><path d="M15.8 10.2h5.2"/>'),
  megaphone: S('<path d="M3.4 10.6v3.2a1.6 1.6 0 0 0 1.6 1.6h2.2l7 4V5l-7 4H5a1.6 1.6 0 0 0-1.6 1.6Z"/><path d="M17.4 9.4a4 4 0 0 1 0 5.2"/><path d="M7.2 15.4V20a1.4 1.4 0 0 0 1.4 1.4h1.2"/>'),
  hash: S('<path d="M9.6 3.6 7.4 20.4M16.6 3.6 14.4 20.4M4.4 8.8h15.2M4 15.2h15.2"/>'),
  lock: S('<rect x="4.6" y="10.4" width="14.8" height="10" rx="3"/><path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6"/>'),
  globe: S('<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.3 2.6 3.4 5.5 3.4 8.6s-1.1 6-3.4 8.6c-2.3-2.6-3.4-5.5-3.4-8.6S9.7 6 12 3.4Z"/>'),
  bell: S('<path d="M18 8.8a6 6 0 0 0-12 0c0 6.4-2.4 7.6-2.4 7.6h16.8S18 15.2 18 8.8Z"/><path d="M10.2 20a2.2 2.2 0 0 0 3.6 0"/>'),
  bellOff: S('<path d="M17.7 17.7H3.6S6 16.4 6 9.4a6 6 0 0 1 9.3-5"/><path d="M17.9 9.4c0 1.5.2 2.7.5 3.7"/><path d="M10.2 20.4a2.2 2.2 0 0 0 3.6 0"/><path d="M3.4 3.4l17.2 17.2"/>'),
  volume: S('<path d="M11 5.4 6.8 9H3.6v6h3.2L11 18.6Z"/><path d="M15.2 9.4a3.6 3.6 0 0 1 0 5.2"/><path d="M17.8 7a7 7 0 0 1 0 10"/>'),
  vibration: S('<rect x="7.6" y="3.4" width="8.8" height="17.2" rx="2.4"/><path d="M3.6 9v6M2 10.6v2.8M20.4 9v6M22 10.6v2.8"/>'),
  palette: S('<path d="M12 3.4a8.6 8.6 0 0 0 0 17.2c1.4 0 2-.9 2-1.8 0-1.4-1.2-1.8-1.2-2.8 0-.8.7-1.4 1.5-1.4h1.6a4.7 4.7 0 0 0 4.7-4.7c0-3.9-4-6.5-8.6-6.5Z"/><circle cx="7.6" cy="12" r="1.2"/><circle cx="10" cy="8.2" r="1.2"/><circle cx="14.6" cy="8.2" r="1.2"/>'),
  type: S('<path d="M4.6 6.4V4.6h14.8v1.8"/><path d="M12 4.6v14.8"/><path d="M8.6 19.4h6.8"/>'),
  sparkles: S('<path d="M12 3.4l1.7 4.4 4.4 1.7-4.4 1.7L12 15.6l-1.7-4.4L5.9 9.5l4.4-1.7Z"/><path d="M18.4 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/><path d="M5.8 16.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6Z"/>'),
  image2: '',
  download: S('<path d="M12 3.6v11.2M7.4 10.4 12 15l4.6-4.6"/><path d="M4.4 17.4v1.2a2.4 2.4 0 0 0 2.4 2.4h10.4a2.4 2.4 0 0 0 2.4-2.4v-1.2"/>'),
  play: S('<path d="M7.6 5.4 18.4 12 7.6 18.6Z"/>'),
  pause: S('<rect x="7" y="5" width="3.6" height="14" rx="1.4"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.4"/>'),
  stop: S('<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="3"/>'),
  zoomIn: S('<circle cx="11" cy="11" r="6.6"/><path d="M11 8.6v4.8M8.6 11h4.8"/><path d="m16 16 4.2 4.2"/>'),
  zoomOut: S('<circle cx="11" cy="11" r="6.6"/><path d="M8.6 11h4.8"/><path d="m16 16 4.2 4.2"/>'),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.4 19.6 6 18M18 6l1.6-1.6"/>'),
  moon: S('<path d="M20.4 14.6A8.6 8.6 0 0 1 9.4 3.6a8.6 8.6 0 1 0 11 11Z"/>'),
  monitor: S('<rect x="2.8" y="4.4" width="18.4" height="12.4" rx="2.6"/><path d="M9 20.4h6M12 16.8v3.6"/>'),
  logout: S('<path d="M15.4 8.4V6a2.4 2.4 0 0 0-2.4-2.4H6.6A2.4 2.4 0 0 0 4.2 6v12a2.4 2.4 0 0 0 2.4 2.4H13a2.4 2.4 0 0 0 2.4-2.4v-2.4"/><path d="M9.6 12h10.8"/><path d="m17.4 8.8 3.2 3.2-3.2 3.2"/>'),
  key: S('<circle cx="8" cy="15.6" r="4"/><path d="m10.8 12.8 7.6-7.6"/><path d="m15.6 8 2.4 2.4"/><path d="m13.6 10 2.4 2.4"/>'),
  mail: S('<rect x="2.8" y="5" width="18.4" height="14" rx="3"/><path d="m3.6 7.4 7.3 5.2a2 2 0 0 0 2.2 0l7.3-5.2"/>'),
  shield: S('<path d="M12 3.2 5 6v5.6c0 4.2 2.9 7.6 7 9.2 4.1-1.6 7-5 7-9.2V6Z"/><path d="m9.2 12 2 2 3.6-4"/>'),
  info: S('<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4M12 8.2h.01"/>'),
  link: S('<path d="M10 13.6a4 4 0 0 0 5.7 0l2.7-2.7a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M14 10.4a4 4 0 0 0-5.7 0l-2.7 2.7a4 4 0 1 0 5.7 5.7l1.4-1.4"/>'),
  filter: S('<path d="M3.6 5.6h16.8l-6.6 7.6v6.2l-3.6-1.8v-4.4Z"/>'),
  eye: S('<path d="M2.4 12S5.9 5.6 12 5.6 21.6 12 21.6 12 18.1 18.4 12 18.4 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="3.1"/>'),
  archive: S('<rect x="3" y="4.4" width="18" height="4.6" rx="2"/><path d="M4.6 9v8.6a2.4 2.4 0 0 0 2.4 2.4h10a2.4 2.4 0 0 0 2.4-2.4V9"/><path d="M9.6 13h4.8"/>'),
  at: S('<circle cx="12" cy="12" r="3.6"/><path d="M15.6 8.4v5a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 6.9"/>'),
  refresh: S('<path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.1"/><path d="M20.4 4.6v4.8h-4.8"/>'),
  retry: S('<path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1"/><path d="M3.6 4.6v4.8h4.8"/>'),
  expand: S('<path d="M9 4.4H4.4V9M15 4.4h4.6V9M15 19.6h4.6V15M9 19.6H4.4V15"/>'),
  wifi: S('<path d="M4.4 9.4a11.4 11.4 0 0 1 15.2 0"/><path d="M7 12.6a7.6 7.6 0 0 1 10 0"/><path d="M9.8 15.8a3.8 3.8 0 0 1 4.4 0"/><path d="M12 19.2h.01"/>'),
  wifiOff: S('<path d="M4.4 9.4a11.4 11.4 0 0 1 6-3.1M14 6.5a11.4 11.4 0 0 1 5.6 2.9"/><path d="M7 12.6a7.6 7.6 0 0 1 3.2-1.7M14.6 11.4a7.6 7.6 0 0 1 2.4 1.2"/><path d="M12 19.2h.01"/><path d="M3.6 3.4 20.4 20.2"/>'),
  dot: S('<circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>'),
  photoStack: S('<rect x="3.4" y="7.4" width="13.2" height="11.2" rx="3"/><path d="M7.4 4.4h9.6a3.2 3.2 0 0 1 3.2 3.2v7.6"/>'),
  pencil: S('<path d="M12 20.4h8.4"/><path d="M16.6 3.9a2.2 2.2 0 0 1 3.1 3.1L8.4 18.3l-4.1 1 1-4.1Z"/>'),
};

/** Иконка как строка (готова к вставке в шаблон). */
export const ic = (name, cls = '') => `<span class="ic ${cls}" aria-hidden="true">${icons[name] || ''}</span>`;

/** Тип чата → иконка. */
export const chatTypeIcon = (type) => (type === 'group' ? 'users' : type === 'channel' ? 'megaphone' : 'user');
