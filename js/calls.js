import { Api } from './api.js?v=20261102-gifts-2';
import { bus, state } from './store.js';
import { esc, fmtTime } from './util.js';
import { icons } from './icons.js';
import { startCallRingtone, stopCallRingtone } from './notify.js';
import './call-ui.js?v=20261030-call-push-2';

let root = null;
let room = null;
let activeCall = null;
let activeChatId = null;
let activeMode = null;
let localTracks = [];
let incomingCall = null;
let pollTimer = null;
let callStartedAt = 0;
let clockTimer = null;
let initialized = false;
let listeningRealtime = false;
let incomingPollFailed = false;

function sdk() {
  const livekit = window.LivekitClient;
  if (!livekit) throw new Error('Не загружен модуль звонков. Обновите страницу и попробуйте снова.');
  return livekit;
}

function showError(message) {
  ensureRoot();
  root.innerHTML = `<section class="call-card call-error" role="alert">
    <button class="call-close" data-call-close aria-label="Закрыть">×</button>
    <div class="call-mark">!</div><h2>Не удалось подключиться</h2><p>${esc(message)}</p>
    <button class="btn btn-primary" data-call-close>Понятно</button>
  </section>`;
}

function showNotice(message) {
  show(`<section class="call-card call-error" role="status">
    <button class="call-close" data-call-close aria-label="Закрыть">×</button>
    <div class="call-mark">${icons.clock}</div><h2>Звонок завершён</h2><p>${esc(message)}</p>
    <button class="btn btn-primary" data-call-close>Закрыть</button>
  </section>`);
}

function ensureRoot() {
  if (root?.isConnected) return root;
  root = document.createElement('div');
  root.className = 'call-root';
  root.hidden = true;
  root.setAttribute('aria-live', 'polite');
  root.addEventListener('click', (event) => {
    onRootClick(event).catch((error) => {
      console.error('Call control failed:', error);
      const status = root.querySelector('[data-call-status]');
      if (status) status.textContent = error.message || 'Не удалось выполнить действие.';
      else showError(error.message || 'Не удалось выполнить действие.');
    });
  });
  document.body.append(root);
  return root;
}

function show(content) {
  ensureRoot();
  root.hidden = false;
  root.innerHTML = content;
  document.body.classList.add('call-open');
}

function hide() {
  if (!root) return;
  stopCallRingtone();
  root.hidden = true;
  root.replaceChildren();
  document.body.classList.remove('call-open');
}

function checkMediaSupport() {
  sdk();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не поддерживает аудио- и видеозвонки. Откройте приложение по защищённому HTTPS-соединению.');
}

async function requestTracks(mediaMode) {
  checkMediaSupport();
  try {
    return await sdk().createLocalTracks({
      audio: true,
      video: mediaMode === 'video' ? { facingMode: 'user' } : false,
    });
  } catch (error) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      throw new Error('Разрешите доступ к микрофону и камере в настройках браузера.');
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      throw new Error('Не найдены микрофон или камера. Проверьте подключённые устройства.');
    }
    throw new Error(`Не удалось включить устройства: ${error.message || 'неизвестная ошибка'}`);
  }
}

function attachTrack(track, participant, isLocal = false) {
  const livekit = sdk();
  if (track.kind === livekit.Track.Kind.Audio) {
    const audio = track.attach();
    audio.autoplay = true;
    audio.className = 'call-audio';
    ensureRoot().append(audio);
    return;
  }
  if (track.kind !== livekit.Track.Kind.Video) return;
  const tile = participantTile(participant, isLocal);
  const video = tile.querySelector('video');
  if (!video) return;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  track.attach(video);
  tile.classList.add('has-video');
}

function participantTile(participant, isLocal = false) {
  ensureRoot();
  const id = isLocal ? 'local' : participant.identity;
  let tile = root.querySelector(`[data-call-participant="${CSS.escape(id)}"]`);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.className = 'call-tile';
  if (isLocal) tile.classList.add('is-local');
  tile.dataset.callParticipant = id;
  const video = document.createElement('video');
  const placeholder = document.createElement('div');
  placeholder.className = 'call-avatar';
  placeholder.textContent = (participant.name || (isLocal ? state.user?.name : ''))?.slice(0, 1)?.toUpperCase() || '•';
  const label = document.createElement('span');
  label.className = 'call-tile-name';
  label.textContent = `${participant.name || (isLocal ? state.user?.name : 'Участник')}${isLocal ? ' · вы' : ''}`;
  tile.append(video, placeholder, label);
  root.querySelector('[data-call-grid]')?.append(tile);
  return tile;
}

function removeParticipant(identity) {
  const tile = root?.querySelector(`[data-call-participant="${CSS.escape(identity)}"]`);
  tile?.remove();
}

function renderActiveCall() {
  const chat = activeChatId ? state.chats.find((item) => item.id === activeChatId) : null;
  const title = chat?.title || chat?.peer?.name || activeCall?.call?.chatTitle || 'Звонок';
  const canEndForAll = activeCall?.call?.startedBy === state.user?.id;
  show(`<section class="call-card call-live" aria-label="Звонок">
    <header class="call-top"><div><span class="call-live-indicator"></span><span data-call-clock>00:00</span></div>
      <button class="call-close" data-call-close aria-label="Свернуть звонок">−</button></header>
    <div class="call-heading"><span class="call-kicker">${activeMode === 'video' ? 'ВИДЕОЗВОНОК' : 'АУДИОЗВОНОК'}</span>
      <h2>${esc(title)}</h2><p data-call-status>Подключаемся…</p></div>
    <div class="call-grid" data-call-grid></div>
    <footer class="call-controls">
      <button class="call-control" data-call-mute aria-pressed="false"><span>${icons.mic}</span><small>Микрофон</small></button>
      ${activeMode === 'video' ? `<button class="call-control" data-call-camera aria-pressed="true"><span>${icons.video}</span><small>Камера</small></button>
      <button class="call-control" data-call-flip><span>↻</span><small>Сменить</small></button>` : ''}
      <button class="call-control" data-call-speaker><span>${icons.volume}</span><small>Звук</small></button>
      <button class="call-control call-hangup" data-call-hangup data-end-all="${canEndForAll}"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 14.2c5.4-4.1 12.6-4.1 18 0l-2.2 4.1a1.4 1.4 0 0 1-1.8.6l-2.4-1.1a1.4 1.4 0 0 1-.8-1.3v-1.1a13 13 0 0 0-5.6 0v1.1a1.4 1.4 0 0 1-.8 1.3L5 19a1.4 1.4 0 0 1-1.8-.6L1 14.3Z"/></svg></span><small>${canEndForAll ? 'Завершить' : 'Покинуть'}</small></button>
    </footer>
    ${canEndForAll ? '<p class="call-host-note">Завершение отключит всех участников</p>' : ''}
  </section>`);
  participantTile({ identity: `local-${state.user?.id}`, name: state.user?.name }, true);
  for (const participant of room?.remoteParticipants.values() || []) participantTile(participant);
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(updateClock, 1000);
  updateClock();
}

function updateClock() {
  const node = root?.querySelector('[data-call-clock]');
  if (!node || !callStartedAt) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000));
  node.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}

async function connectToCall(info, tracks) {
  const url = info.serverUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
  const livekit = sdk();
  const liveRoom = new livekit.Room({ adaptiveStream: true, dynacast: true });
  room = liveRoom;
  activeCall = info;
  activeMode = info.call.mediaMode;
  activeChatId = info.call.chatId;
  localTracks = tracks;
  callStartedAt = Date.now();
  renderActiveCall();
  liveRoom.on(livekit.RoomEvent.TrackSubscribed, (track, publication, participant) => attachTrack(track, participant));
  liveRoom.on(livekit.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    track.detach().forEach((element) => element.remove());
    if (track.kind === livekit.Track.Kind.Video && !participant.getTrackPublications().some((item) => item.track?.kind === livekit.Track.Kind.Video)) {
      removeParticipant(participant.identity);
    }
  });
  liveRoom.on(livekit.RoomEvent.ParticipantConnected, (participant) => {
    participantTile(participant);
    updateCallStatus();
  });
  liveRoom.on(livekit.RoomEvent.ParticipantDisconnected, (participant) => {
    removeParticipant(participant.identity);
    updateCallStatus();
  });
  liveRoom.on(livekit.RoomEvent.Disconnected, () => {
    if (room === liveRoom) finishLocally('Соединение со звонком прервано');
  });

  try {
    await liveRoom.connect(url, info.token);
    for (const track of tracks) {
      if (track.kind === livekit.Track.Kind.Video && info.call.mediaMode !== 'video') {
        track.stop();
        continue;
      }
      await liveRoom.localParticipant.publishTrack(track);
      if (track.kind === livekit.Track.Kind.Video) attachTrack(track, { identity: `local-${state.user?.id}`, name: state.user?.name }, true);
    }
    const status = root.querySelector('[data-call-status]');
    if (status) status.textContent = 'На связи';
    updateCallStatus();
  } catch (error) {
    room = null;
    liveRoom.disconnect();
    await releaseTracks();
    activeCall = null;
    activeChatId = null;
    activeMode = null;
    callStartedAt = 0;
    throw new Error(`Не удалось подключиться к комнате звонка: ${error.message || 'проверьте соединение и настройки сервера'}`);
  }
}

function updateCallStatus() {
  const node = root?.querySelector('[data-call-status]');
  if (!node || !room) return;
  const count = room.remoteParticipants.size + 1;
  node.textContent = `${count} ${count === 1 ? 'участник' : count < 5 ? 'участника' : 'участников'}`;
}

async function releaseTracks() {
  for (const track of localTracks) {
    try { track.stop(); } catch (error) { console.error('Unable to stop local call track:', error); }
  }
  localTracks = [];
}

function finishLocally(message = null) {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  const oldRoom = room;
  room = null;
  oldRoom?.disconnect();
  void releaseTracks();
  activeCall = null;
  activeChatId = null;
  activeMode = null;
  callStartedAt = 0;
  if (message) showNotice(message);
  else hide();
}

export async function startCall(chatId, mediaMode) {
  if (activeCall) {
    showError('Вы уже участвуете в звонке. Завершите его перед новым вызовом.');
    return;
  }
  let tracks = [];
  let info = null;
  try {
    tracks = await requestTracks(mediaMode);
    info = await Api.startCall(chatId, mediaMode);
    await connectToCall(info, tracks);
  } catch (error) {
    for (const track of tracks) track.stop();
    if (info?.call?.id) {
      try { await Api.leaveCall(info.call.id, info.call.startedBy === state.user?.id); }
      catch (cleanupError) { console.error('Unable to clean up failed call start:', cleanupError); }
    }
    showError(error.message || 'Попробуйте ещё раз позже.');
  }
}

async function acceptIncoming(call) {
  if (!call) return;
  stopCallRingtone();
  if (activeCall) {
    showError('Сначала завершите текущий звонок.');
    return;
  }
  incomingCall = null;
  let tracks = [];
  let info = null;
  try {
    tracks = await requestTracks(call.mediaMode);
    info = await Api.joinCall(call.id);
    await connectToCall(info, tracks);
  } catch (error) {
    for (const track of tracks) track.stop();
    if (info?.call?.id) {
      try { await Api.leaveCall(info.call.id); }
      catch (cleanupError) { console.error('Unable to clean up failed call join:', cleanupError); }
    }
    showError(error.message || 'Не удалось принять звонок.');
  }
}

async function declineIncoming(call) {
  if (!call) return;
  stopCallRingtone();
  incomingCall = null;
  try {
    await Api.declineCall(call.id);
    hide();
  } catch (error) {
    showError(error.message || 'Не удалось отклонить звонок.');
  }
}

async function hangup() {
  if (!activeCall) return hide();
  const call = activeCall;
  const endForAll = root.querySelector('[data-call-hangup]')?.dataset.endAll === 'true';
  try {
    await Api.leaveCall(call.call.id, endForAll);
    finishLocally();
  } catch (error) {
    showError(error.message || 'Не удалось завершить звонок на сервере.');
  }
}

async function onRootClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.matches('[data-call-close]')) {
    if (activeCall) {
      root.classList.toggle('call-minimized');
      button.textContent = root.classList.contains('call-minimized') ? '+' : '−';
    } else hide();
    return;
  }
  if (button.matches('[data-call-restore]')) {
    root.classList.remove('call-minimized');
    return;
  }
  if (button.matches('[data-call-accept]')) return acceptIncoming(incomingCall);
  if (button.matches('[data-call-decline]')) return declineIncoming(incomingCall);
  if (button.matches('[data-call-hangup]')) return hangup();
  if (button.matches('[data-call-mute]') && room) {
    const enabled = !room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(enabled);
    button.setAttribute('aria-pressed', String(!enabled));
    button.classList.toggle('is-off', !enabled);
    button.querySelector('small').textContent = enabled ? 'Микрофон' : 'Без звука';
  }
  if (button.matches('[data-call-camera]') && room) {
    const enabled = !room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('is-off', !enabled);
    button.querySelector('small').textContent = enabled ? 'Камера' : 'Камера выкл.';
  }
  if (button.matches('[data-call-flip]') && room) await switchDevice('videoinput');
  if (button.matches('[data-call-speaker]') && room) await switchDevice('audiooutput');
  if (button.matches('[data-call-history]')) return openHistory(activeChatId);
  if (button.matches('[data-history-close]')) hide();
}

async function switchDevice(kind) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const candidates = devices.filter((device) => device.kind === kind && device.deviceId);
    if (candidates.length < 2) {
      if (kind === 'videoinput') throw new Error('Доступна только одна камера.');
      const current = room.getActiveDevice(kind);
      await room.switchActiveDevice(kind, current === 'default' ? 'communications' : 'default');
      return;
    }
    const current = room.getActiveDevice(kind);
    const next = candidates[(candidates.findIndex((device) => device.deviceId === current) + 1) % candidates.length];
    await room.switchActiveDevice(kind, next.deviceId);
  } catch (error) {
    console.error('Unable to switch call device:', error);
    const status = root?.querySelector('[data-call-status]');
    if (status) status.textContent = error.message || 'Не удалось переключить устройство.';
  }
}

function renderIncoming(call) {
  incomingCall = call;
  const caller = call.callerName || call.chatTitle || '';
  const sub = call.chatTitle && call.chatTitle !== caller ? call.chatTitle : '';
  const initial = (caller || '•').trim().slice(0, 1).toUpperCase();
  const phone = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  show(`<section class="call-card call-incoming" aria-label="Входящий звонок">
    <div class="call-caller" aria-hidden="true">${esc(initial)}<span class="call-caller-badge">${call.mediaMode === 'video' ? icons.video : icons.mic}</span></div>
    <span class="call-kicker">ВХОДЯЩИЙ ${call.mediaMode === 'video' ? 'ВИДЕО' : 'АУДИО'}ЗВОНОК</span>
    <h2>${esc(caller)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}
    <div class="call-incoming-actions">
      <div class="call-act"><button class="call-control call-hangup" data-call-decline aria-label="Отклонить"><span>${phone}</span></button><small>Отклонить</small></div>
      <div class="call-act"><button class="call-control call-answer" data-call-accept aria-label="Принять"><span>${phone}</span></button><small>Принять</small></div>
    </div>
  </section>`);
  startCallRingtone();
}

export async function openHistory(chatId = null) {
  try {
    const { calls } = await Api.callHistory(chatId);
    const items = calls.length ? calls.map((call) => `<li class="call-history-item">
      <span class="call-history-icon ${call.missed ? 'is-missed' : ''}">${call.mediaMode === 'video' ? icons.video : icons.mic}</span>
      <span class="call-history-copy"><strong>${esc(call.chatTitle)}</strong>
        <small>${call.missed ? 'Пропущенный' : call.status === 'declined' ? 'Отклонённый' : call.startedBy === state.user?.id ? 'Исходящий' : 'Входящий'}
          · ${call.mediaMode === 'video' ? 'видео' : 'аудио'} · ${esc(new Date(call.startedAt).toLocaleString('ru-RU'))}</small></span>
      <span class="call-history-time">${esc(fmtTime(call.startedAt))}</span>
    </li>`).join('') : '<li class="call-history-empty">История звонков пока пуста</li>';
    show(`<section class="call-card call-history" aria-label="История звонков">
      <header class="call-history-head"><h2>История звонков</h2><button class="call-close" data-history-close aria-label="Закрыть">×</button></header>
      <ul>${items}</ul></section>`);
  } catch (error) {
    showError(error.message || 'Не удалось загрузить историю звонков.');
  }
}

async function pollIncoming() {
  try {
    const { calls } = await Api.incomingCalls();
    incomingPollFailed = false;
    const url = new URL(location.href);
    const action = url.searchParams.get('callAction');
    const callId = url.searchParams.get('callId');
    const actionAt = Number(url.searchParams.get('callActionAt'));
    const hasPendingAction = ['answer', 'decline'].includes(action)
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId || '')
      && Number.isFinite(actionAt)
      && Date.now() - actionAt < 120_000
      && actionAt <= Date.now() + 10_000;
    if (hasPendingAction) {
      const call = calls.find((item) => item.id === callId);
      if (call) {
        url.searchParams.delete('callAction');
        url.searchParams.delete('callId');
        url.searchParams.delete('callActionAt');
        history.replaceState(history.state, '', url);
        incomingCall = call;
        if (action === 'answer') await acceptIncoming(call);
        else await declineIncoming(call);
        return;
      }
      if (Date.now() - actionAt >= 120_000) {
        url.searchParams.delete('callAction');
        url.searchParams.delete('callId');
        url.searchParams.delete('callActionAt');
        history.replaceState(history.state, '', url);
      }
    }
    if (activeCall) return;
    if (incomingCall && !calls.some((call) => call.id === incomingCall.id)) {
      incomingCall = null;
      if (root?.querySelector('.call-incoming')) hide();
    }
    if (incomingCall) return;
    if (calls.length) renderIncoming(calls[0]);
  } catch (error) {
    if (!incomingPollFailed) console.error('Unable to check incoming calls:', error);
    incomingPollFailed = true;
  }
}

export function init() {
  if (initialized && pollTimer) return;
  initialized = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && incomingCall) startCallRingtone();
  });
  if (!listeningRealtime) {
    listeningRealtime = true;
    bus.on('rt', (event) => {
      if (event.type === 'call.incoming') {
        if (!activeCall && !incomingCall) renderIncoming(event.call);
      } else if (event.type === 'call.ended' && event.callId === activeCall?.call?.id) {
        finishLocally('Звонок завершён');
      } else if (event.type === 'call.ended' && event.callId === incomingCall?.id) {
        incomingCall = null;
        hide();
      } else if (event.type === 'call.accepted' && event.callId === incomingCall?.id) {
        incomingCall = null;
        hide();
      } else if (event.type === 'call.declined' && event.callId === incomingCall?.id) {
        incomingCall = null;
        hide();
      } else if (event.type === 'call.declined' && event.callId === activeCall?.call?.id) {
        const status = root?.querySelector('[data-call-status]');
        if (status) status.textContent = 'Приглашение отклонено';
      }
    });
  }
  pollIncoming();
  pollTimer = setInterval(pollIncoming, 5000);
}

export function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (activeCall) {
    Api.leaveCall(activeCall.call.id, activeCall.call.startedBy === state.user?.id)
      .catch((error) => console.error('Unable to leave call during logout:', error));
  }
  finishLocally();
  incomingCall = null;
}
