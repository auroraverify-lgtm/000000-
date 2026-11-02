import { PREMIUM_WALLPAPERS } from '../premium.js?v=20261031-verified-badge-1';
/** Акценты и варианты обоев — используются в настройках внешнего вида. */
export const ACCENTS = [
  { id: 'violet', label: 'Аметист', from: '#7c5cff', to: '#c084fc' },
  { id: 'ocean', label: 'Океан', from: '#087fff', to: '#168bff' },
  { id: 'sunset', label: 'Закат', from: '#ff7a45', to: '#ffd166' },
  { id: 'mint', label: 'Мята', from: '#16c79a', to: '#7ee8c8' },
  { id: 'coral', label: 'Коралл', from: '#ff5d73', to: '#ff9aa8' },
];

const BASE_WALLPAPERS = [
  { id: 'aurora', label: 'Космос', preview: "url('/assets/wall-cosmos.svg') center/cover" },
  { id: 'dusk', label: 'Сумерки', preview: 'radial-gradient(120% 90% at 15% 0%, #2a1f52, transparent 55%), linear-gradient(160deg, #0a0b14, #101223 60%, #0a0d18)' },
  { id: 'dune', label: 'Дюна', preview: 'radial-gradient(90% 70% at 20% 10%, #4a2f1d, transparent 55%), linear-gradient(170deg, #14100d, #1d1712)' },
  { id: 'graphite', label: 'Графит', preview: 'linear-gradient(180deg, #14161d, #0a0c11)' },
  { id: 'paper', label: 'Бумага', preview: 'linear-gradient(180deg, #fbfbfe, #f2f3fa)' },
];

export const WALLPAPERS = [...BASE_WALLPAPERS, ...PREMIUM_WALLPAPERS.map(({ id, label, preview, premium }) => ({ id, label, preview, premium }))];
