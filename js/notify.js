/**
 * Уведомления: звук (синтез через WebAudio — без внешних файлов), вибрация,
 * всплывающие подсказки, системные уведомления браузера и счётчик в заголовке вкладки.
 */
import { state, chatById } from './store.js';
import { toast } from './ui.js?v=20261029-no-toasts-1';
import { haptic, store9 } from './util.js';

let ctx = null;
let callRingtoneTimer = null;
const SOUND_FILES = {
  'universfield-new-notification-051-494246': '/universfield-new-notification-051-494246.mp3',
  'universfield-new-notification-040-493469': '/universfield-new-notification-040-493469.mp3',
  'universfield-new-notification-017-352293': '/universfield-new-notification-017-352293.mp3',
};
const soundCache = new Map();

function audio() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  }
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Короткий «двухнотный» сигнал — приятный и не резкий. */
export function playPing({ kind = 'in' } = {}) {
  if (kind === 'in') {
    const selected = state.settings.notify.sound || 'default';
    const file = SOUND_FILES[selected];
    if (file) {
      let player = soundCache.get(selected);
      if (!player) {
        player = new Audio(file);
        player.preload = 'auto';
        soundCache.set(selected, player);
      }
      player.currentTime = 0;
      player.play().catch(() => {});
      return;
    }
  }
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const gain = ac.createGain();
  gain.connect(ac.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

  const notes = kind === 'out' ? [740, 988] : [587.33, 880];
  notes.forEach((freq, i) => {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + i * 0.11);
    osc.connect(gain);
    osc.start(now + i * 0.11);
    osc.stop(now + i * 0.11 + 0.32);
  });
}

function playCallRingtone() {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const gain = ac.createGain();
  gain.connect(ac.destination);
  gain.gain.setValueAtTime(0.0001, now);
  for (const start of [0, 0.75]) {
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.07, now + start + 0.03);
    gain.gain.setValueAtTime(0.07, now + start + 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.42);
  }
  for (const frequency of [440, 480]) {
    const oscillator = ac.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + 1.25);
  }
}

export function startCallRingtone() {
  stopCallRingtone();
  if (!state.settings.notify.sounds || document.visibilityState !== 'visible') return;
  playCallRingtone();
  callRingtoneTimer = setInterval(() => {
    if (document.visibilityState === 'visible') playCallRingtone();
  }, 3000);
}

export function stopCallRingtone() {
  if (callRingtoneTimer) clearInterval(callRingtoneTimer);
  callRingtoneTimer = null;
}

export function notificationsAllowed() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const res = await Notification.requestPermission();
    return res === 'granted';
  } catch { return false; }
}

function settingsForNotification(chat) {
  const s = state.settings;
  if (!chat) return false;
  if (chat.muted) return false;
  const group = chat.type === 'group' || chat.type === 'channel';
  if (chat.type === 'channel' && !s.notify.channels) return false;
  if (chat.type === 'group' && !s.notify.groups) return false;
  if (chat.type === 'dm' && !s.notify.messages) return false;
  return !group ? s.notify.messages : true;
}

function previewOf(message, chat) {
  const sender = chat?.type === 'dm' ? null : senderName(message.senderId);
  const body = message.type === 'text' ? message.text
    : message.type === 'photo' ? '📷 Фото'
      : message.type === 'video' ? '🎬 Видео'
        : message.type === 'voice' ? '🎤 Голосовое сообщение'
          : message.type === 'file' ? `📎 ${message.media?.filename || 'Файл'}`
            : message.type === 'sticker' ? '✨ Стикер'
              : message.type === 'gift' ? `Вам отправили подарок: ${message.gift?.name || 'подарок'}` : 'Сообщение';
  if (!state.settings.notify.preview) return { title: chat?.title || 'Новое сообщение', body: 'Новое сообщение' };
  return { title: sender ? `${sender} · ${chat?.title || ''}`.trim() : (chat?.title || 'Новое сообщение'), body };
}

function senderName(userId) {
  if (!state.user) return null;
  if (userId === state.user.id) return state.user.name;
  for (const chat of state.chats) {
    const m = state.membersByChat[chat.id]?.find((x) => x.id === userId);
    if (m) return m.name;
    if (chat.peer?.id === userId) return chat.peer.name;
  }
  return null;
}

export function notifyMessage(message, { isActiveChat = false, windowHidden = false } = {}) {
  const chat = chatById(message.chatId);
  if (!state.user || message.senderId === state.user.id) return;
  const allowed = settingsForNotification(chat);

  // В открытом чате уведомление не нужно: пользователь уже видит новое сообщение.
  if (allowed && state.settings.notify.sounds && !isActiveChat) playPing({ kind: 'in' });
  if (allowed && state.settings.notify.vibration && windowHidden) haptic([12, 40, 12]);

  if (!allowed) return;
  if (isActiveChat && !windowHidden) return;

  const { title, body } = previewOf(message, chat);
  const backgroundPushEnabled = store9.get('aurora.push.enabled', false);
  if (windowHidden && notificationsAllowed() && !backgroundPushEnabled) {
    try {
      const n = new Notification(title, {
        body,
        icon: '/assets/icons/app-icon.svg',
        badge: '/assets/icons/favicon.svg',
        image: message.type === 'gift' ? message.gift?.imageUrl : undefined,
        tag: `aurora-${message.chatId}`,
      });
      n.onclick = () => { window.focus(); n.close(); location.hash = `#/chat/${message.chatId}`; };
      return;
    } catch { /* fallback ниже */ }
  }
  toast(`${title}${body ? `: ${body}` : ''}`, {
    type: 'info',
    timeout: 4200,
    action: { label: 'Открыть', onClick: () => { location.hash = `#/chat/${message.chatId}`; } },
  });
}

/** Заголовок вкладки отражает непрочитанные — привычно для веб-мессенджеров. */
export function updateTitle(unread) {
  const base = 'Aurora — мессенджер';
  document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
}

export function playSent() {
  if (state.settings.notify.sounds) playPing({ kind: 'out' });
}
