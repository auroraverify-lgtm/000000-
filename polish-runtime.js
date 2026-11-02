/**
 * Аккуратные «надстройки» интерфейса, не требующие правок больших файлов:
 *  · канал: подписчику вместо «могут писать только админы» — кнопка «Отключить / Включить уведомления»;
 *  · разметка data-chat-type на области диалога (стили каналов);
 *  · окна «Новый канал / Новая группа»: значок в шапке и живой предпросмотр карточки.
 * Всё идемпотентно и безопасно: исходные узлы не удаляются, только скрываются стилями.
 */
import { state, chatById, patchChat } from '../store.js';
import { Api } from '../api.js?v=20261102-gifts-2';
import { icons } from '../icons.js';
import { toast, toastError } from '../ui.js?v=20261029-no-toasts-1';
import { $, $$, initials, plural } from '../util.js';

let scheduled = false;
const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; run(); });
};

function run() {
  tagConversation();
  enhanceChannelComposer();
  $$('.modal:not([data-polished])').forEach(enhanceModal);
}

function tagConversation() {
  const conv = $('[data-conv]');
  if (!conv) return;
  const type = state.chat?.chat?.type || '';
  if (conv.dataset.chatType !== type) conv.dataset.chatType = type;
}

const isMuted = () => {
  const id = state.chat?.chat?.id;
  return !!(chatById(id)?.muted ?? state.chat?.chat?.muted);
};

function enhanceChannelComposer() {
  const composer = $('[data-composer]');
  if (!composer) return;
  const input = composer.querySelector('.composer-input');
  const readOnlyChannel = !!input?.disabled && state.chat?.chat?.type === 'channel';
  let bar = composer.querySelector(':scope > .chan-bar');

  if (!readOnlyChannel) {
    if (bar) { bar.remove(); composer.classList.remove('chan-composer'); }
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'chan-bar';
    bar.innerHTML = '<button type="button" class="chan-mute" data-chan-mute><span class="ic"></span><span class="lbl"></span></button><span class="chan-count"></span>';
    composer.append(bar);
    bar.querySelector('[data-chan-mute]').addEventListener('click', () => toggleMute(bar));
  }
  composer.classList.add('chan-composer');
  paintBar(bar);
}

function paintBar(bar) {
  const muted = isMuted();
  const btn = bar.querySelector('[data-chan-mute]');
  btn.classList.toggle('is-muted', muted);
  btn.querySelector('.ic').innerHTML = muted ? icons.bell : icons.bellOff;
  btn.querySelector('.lbl').textContent = muted ? 'Включить уведомления' : 'Отключить уведомления';
  const n = state.chat?.chat?.memberCount;
  bar.querySelector('.chan-count').textContent = n ? `${n} ${plural(n, 'подписчик', 'подписчика', 'подписчиков')}` : '';
}

async function toggleMute(bar) {
  const id = state.chat?.chat?.id;
  if (!id) return;
  const next = !isMuted();
  const btn = bar.querySelector('[data-chan-mute]');
  btn.disabled = true;
  try {
    const res = await Api.chatPrefs(id, { muted: next });
    const muted = typeof res?.muted === 'boolean' ? res.muted : next;
    patchChat(id, { muted });
    if (state.chat?.chat) state.chat.chat.muted = muted;
    paintBar(bar);
    toast(muted ? 'Уведомления канала отключены' : 'Уведомления канала включены', { type: 'success', timeout: 1600 });
  } catch (err) { toastError(err); }
  finally { btn.disabled = false; }
}

function enhanceModal(modal) {
  const title = $('.modal-header h3', modal)?.textContent?.trim();
  const kind = title === 'Новый канал' ? 'channel' : title === 'Новая группа' ? 'group' : null;
  if (!kind) { if (title) modal.dataset.polished = '0'; return; }
  modal.dataset.polished = '1';
  modal.classList.add('create-modal', `create-${kind}`);

  const header = $('.modal-header', modal);
  const badge = document.createElement('span');
  badge.className = 'create-badge';
  badge.innerHTML = kind === 'channel' ? icons.megaphone : icons.users;
  header?.prepend(badge);

  const body = $('.modal-body', modal);
  if (!body) return;
  const preview = document.createElement('div');
  preview.className = 'create-preview';
  preview.innerHTML = `<span class="cp-avatar" data-c="${kind === 'channel' ? 'ocean' : 'indigo'}"></span>
    <span class="cp-text"><b class="cp-title"></b><small class="cp-sub"></small></span>`;
  body.prepend(preview);

  const refresh = () => {
    const texts = $$('input.input', modal).filter((i) => i.type === 'text');
    const name = (texts[0]?.value || '').trim();
    const linkInput = kind === 'channel' ? texts[1] : null;
    const username = linkInput && !linkInput.closest('[hidden]') ? linkInput.value.trim() : '';
    const img = $('.avatar-drop img', modal);
    const av = $('.cp-avatar', preview);
    if (img) av.innerHTML = `<img src="${img.src}" alt="">`;
    else av.textContent = initials(name || (kind === 'channel' ? 'Канал' : 'Группа'));
    $('.cp-title', preview).textContent = name || (kind === 'channel' ? 'Название канала' : 'Название группы');
    $('.cp-sub', preview).textContent = kind === 'channel'
      ? `${username ? `@${username} · ` : ''}канал · 0 подписчиков`
      : 'группа · вы и выбранные участники';
  };
  modal.addEventListener('input', refresh);
  modal.addEventListener('change', refresh);
  const drop = $('.avatar-drop', modal);
  if (drop) new MutationObserver(refresh).observe(drop, { childList: true, subtree: true });
  refresh();
}

new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
schedule();
