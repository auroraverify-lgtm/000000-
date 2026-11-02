/**
 * Общие помощники: представления (DTO) объектов API и проверки прав доступа.
 * Единая точка: ни один маршрут не отдаёт «сырые» строки БД наружу.
 */
import crypto from 'node:crypto';
import { db, users, settings, chats, reactions, comments, blocks, polls } from './db.js';
import { mediaDTO } from './storage.js';
import { signMedia } from './security.js';
import { PREMIUM_WALLPAPER_IDS } from './config.js';

const activePremium = db.prepare("SELECT 1 FROM premium_subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > ? LIMIT 1");
const sharedContactQuery = db.prepare(`SELECT 1 FROM chat_members a
  JOIN chat_members b ON a.chat_id = b.chat_id
  JOIN chats c ON c.id = a.chat_id
  WHERE a.user_id = ? AND b.user_id = ? AND c.type IN ('group', 'channel')
  LIMIT 1`);
const DEFAULT_GIFT_ART = new Set(['rose', 'star', 'diamond', 'crown', 'rocket', 'galaxy', 'aurora']);

export function giftImageUrl(gift, ttlMs = 30 * 24 * 3600 * 1000) {
  if (gift?.image_media_id) return signMedia(gift.image_media_id, ttlMs);
  return DEFAULT_GIFT_ART.has(gift?.id) ? `/assets/gifts/${gift.id}.svg` : null;
}

export function sharesContact(userId, otherUserId) {
  return userId === otherUserId || !!sharedContactQuery.get(userId, otherUserId);
}

function isVisibleTo(ownerId, viewerId, audience) {
  if (ownerId === viewerId) return true;
  if (audience === 'everyone') return true;
  if (audience === 'contacts') return !!viewerId && sharesContact(ownerId, viewerId);
  return false;
}

export function canViewProfile(ownerId, viewerId, ownerSettings = null) {
  const st = ownerSettings || settings.byUser.get(ownerId);
  return isVisibleTo(ownerId, viewerId, st?.privacy_profile || 'everyone');
}

export function canViewStatus(ownerId, viewerId, ownerSettings = null) {
  const st = ownerSettings || settings.byUser.get(ownerId);
  return isVisibleTo(ownerId, viewerId, st?.privacy_status || 'everyone');
}

export function canAddToGroup(ownerId, inviterId, ownerSettings = null) {
  const st = ownerSettings || settings.byUser.get(ownerId);
  return isVisibleTo(ownerId, inviterId, st?.privacy_groups || 'everyone');
}

export function userDTO(u, viewerId = null, s = null) {
  if (!u) return null;
  const st = s || settings.byUser.get(u.id);
  const profileVisible = canViewProfile(u.id, viewerId, st);
  const statusVisible = canViewStatus(u.id, viewerId, st);
  const isPremium = !!activePremium.get(u.id, Date.now());
  let badges = [];
  try {
    badges = db.prepare('SELECT badge FROM user_badges WHERE user_id = ? ORDER BY badge').all(u.id).map((row) => row.badge);
  } catch {
    badges = [];
  }
  const profileVideo = isPremium && profileVisible && u.profile_banner_video_media_id
    ? signMedia(u.profile_banner_video_media_id, 30 * 24 * 3600 * 1000)
    : null;
  const defaultProfileEffects = { theme: 'none', ring: 'none', nameFx: 'none', dim: 0 };
  let profileEffects = defaultProfileEffects;
  if (profileVisible) {
    try {
      const saved = JSON.parse(u.profile_effects || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        profileEffects = {
          theme: ['none', 'halloween', 'newyear', 'summer', 'jungle', 'snow', 'neon'].includes(saved.theme) ? saved.theme : 'none',
          ring: ['none', 'gradient', 'rainbow'].includes(saved.ring) ? saved.ring : 'none',
          nameFx: ['none', 'glow', 'gradient'].includes(saved.nameFx) ? saved.nameFx : 'none',
          dim: Number.isInteger(saved.dim) && saved.dim >= 0 && saved.dim <= 6 ? saved.dim : 0,
        };
      }
    } catch {
      profileEffects = defaultProfileEffects;
    }
  }
  return {
    id: u.id,
    isBot: !!u.is_bot,
    badges,
    verified: badges.includes('verified'),
    isPremium,
    premiumBadge: isPremium && profileVisible ? (u.premium_badge || 'aurora') : null,
    premiumEmoji: isPremium && profileVisible ? (u.premium_emoji || null) : null,
    name: u.name,
    username: u.username,
    bio: profileVisible ? u.bio : '',
    statusText: statusVisible ? u.status_text : '',
    avatarUrl: u.avatar_url ? signMedia(u.avatar_url, 30 * 24 * 3600 * 1000) : null,
    avatarColor: u.avatar_color,
    profileBg: profileVisible && u.profile_bg ? signMedia(u.profile_bg, 30 * 24 * 3600 * 1000) : null,
    profileBanner: profileVisible && u.profile_banner ? signMedia(u.profile_banner, 30 * 24 * 3600 * 1000) : null,
    profileBannerVideo: profileVideo,
    profileTheme: profileVisible ? u.profile_theme || 'aurora' : 'aurora',
    profileEffects,
    profileEmoji: profileVisible ? u.profile_emoji || '✨' : '✨',
    profileText: profileVisible ? u.profile_text || '' : '',
    profileStickers: profileVisible ? (() => { try { return JSON.parse(u.profile_stickers || '[]'); } catch { return []; } })() : [],
    personalChannelId: profileVisible ? u.personal_channel_id || null : null,
    presence: statusVisible ? u.presence : null,
    lastSeen: statusVisible ? u.last_seen : null,
    createdAt: profileVisible ? u.created_at : null,
    // приватность: чужие настройки не раскрываем, отдаём только видимость профиля
    isSelf: viewerId === u.id,
    email: viewerId === u.id ? u.email : undefined,
    emailVerified: viewerId === u.id ? !!u.email_verified : undefined,
    emailVerificationDeadlineAt: viewerId === u.id ? (u.email_verification_deadline_at || null) : undefined,
    emailVerificationRequestedAt: viewerId === u.id ? (u.email_verification_requested_at || null) : undefined,
    settings: viewerId === u.id ? settingsDTO(st) : undefined,
  };
}

export function settingsDTO(s) {
  if (!s) return null;
  let wallpaper = s.wallpaper;
  if (PREMIUM_WALLPAPER_IDS.includes(wallpaper) && !activePremium.get(s.user_id, Date.now())) {
    settings.updateWallpaper.run('aurora', Date.now(), s.user_id);
    wallpaper = 'aurora';
  }
  return {
    theme: s.theme, accent: s.accent, fontScale: s.font_scale, animations: !!s.animations,
    compact: !!s.compact, wallpaper,
    notify: {
      messages: !!s.notify_messages, groups: !!s.notify_groups, channels: !!s.notify_channels,
      sounds: !!s.notify_sounds, sound: s.notify_sound || 'default', vibration: !!s.notify_vibration, preview: !!s.notify_preview,
    },
    privacy: {
      messages: s.privacy_messages, profile: s.privacy_profile,
      groups: s.privacy_groups, status: s.privacy_status,
    },
  };
}

/** Сообщение в формате, который сразу понимает фронтенд. */
export function messageDTO(row, { requesterId, members = [], mediaRow = null, mediaRows = [], reactionRows = null, commentCounts = null, statusOverride = null } = {}) {
  const deletedForAll = !!row.deleted_for_all;
  const myReaction = reactionRows ? reactionRows.find((r) => r.user_id === requesterId)?.emoji || null : null;
  const grouped = new Map();
  for (const r of reactionRows || []) {
    const g = grouped.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false, users: [] };
    g.count++;
    if (r.user_id === requesterId) g.mine = true;
    g.users.push({ id: r.user_id, name: r.name, username: r.username });
    grouped.set(r.emoji, g);
  }
  const poll = !deletedForAll && row.type === 'poll' ? polls.byMessage.get(row.id) : null;
  const giftRow = !deletedForAll && row.type === 'gift' ? db.prepare(`SELECT rg.*, g.emoji, g.name, g.description, g.animation, g.image_media_id,
      u.username AS sender_username, u.name AS sender_name
    FROM received_gifts rg JOIN gifts g ON g.id = rg.gift_id JOIN users u ON u.id = rg.sender_id
    WHERE rg.message_id = ?`).get(row.id) : null;
  let pollDTO = null;
  if (poll) {
    let options = [];
    try { options = JSON.parse(poll.options_json); } catch { options = []; }
    const votes = polls.votes.all(poll.message_id);
    pollDTO = {
      question: poll.question,
      allowMultiple: !!poll.allow_multiple,
      options: options.map((option) => ({
        id: option.id, text: option.text,
        votes: votes.filter((v) => v.option_id === option.id).length,
        selected: votes.some((v) => v.option_id === option.id && v.user_id === requesterId),
      })),
    };
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    topicId: row.topic_id ?? null,
    seq: row.seq,
    senderId: row.sender_id,
    type: row.type,
    text: row.deleted_for_all ? '' : row.text,
    sticker: deletedForAll ? null : row.sticker,
    poll: pollDTO,
    gift: giftRow ? {
      id: giftRow.gift_id, emoji: giftRow.emoji, name: giftRow.name, description: giftRow.description,
      animation: giftRow.animation, rarity: giftRow.rarity, imageUrl: giftRow.image_media_id ? signMedia(giftRow.image_media_id, 30 * 24 * 3600 * 1000) : null, price: giftRow.price, note: giftRow.note,
      senderUsername: giftRow.sender_username, senderName: giftRow.sender_name, createdAt: giftRow.created_at,
    } : null,
    media: !deletedForAll && mediaRow ? mediaDTO(mediaRow) : null,
    mediaItems: deletedForAll ? [] : (mediaRows.length ? mediaRows.map(mediaDTO) : (mediaRow ? [mediaDTO(mediaRow)] : [])),
    replyTo: row.reply_to,
    forward: row.fwd_from_user || row.fwd_from_chat
      ? { userId: row.fwd_from_user, chatId: row.fwd_from_chat, fromMe: row.fwd_from_user === requesterId }
      : null,
    editedAt: row.edited_at,
    deletedForAll: !!row.deleted_for_all,
    pinned: !!row.pinned,
    views: row.views,
    commentsCount: deletedForAll ? 0 : (commentCounts?.[row.id] || 0),
    createdAt: row.created_at,
    reactions: deletedForAll ? [] : [...grouped.values()].sort((a, b) => b.count - a.count),
    myReaction: deletedForAll ? null : myReaction,
    status: statusOverride || computeStatus(row, requesterId, members),
  };
}

/** sent → delivered → read, вычисляется на сервере из положения курсоров чтения участников. */
export function computeStatus(row, requesterId, members = []) {
  if (!row || row.sender_id !== requesterId) return null;
  const others = members.filter((m) => m.user_id !== requesterId);
  if (!others.length) return 'sent';
  const allRead = others.every((m) => m.last_read_seq >= row.seq);
  if (allRead) return 'read';
  const allDelivered = others.every((m) => m.last_delivered_seq >= row.seq);
  return allDelivered ? 'delivered' : 'sent';
}

/** Кусок диалога для превью ответа/пересылки. */
export function snippetDTO(row, chat = null) {
  if (!row) return null;
  const preview = row.deleted_for_all ? 'сообщение удалено'
    : row.type === 'photo' ? 'фото'
      : row.type === 'video' ? 'видео'
        : row.type === 'voice' ? 'голосовое сообщение'
          : row.type === 'file' ? 'файл'
            : row.type === 'sticker' ? (row.sticker || 'стикер')
              : String(row.text || '').slice(0, 160);
  return { id: row.id, seq: row.seq, senderId: row.sender_id, preview, chatId: row.chat_id, title: chat?.title || null };
}

/** Чат в формате списка. */
export function chatDTO(chat, { viewerId, members = [], lastMessage = null, unread = 0, pinnedMsg = null } = {}) {
  const other = chat.type === 'dm' ? members.find((m) => m.user_id !== viewerId) : null;
  const viewerMember = members.find((m) => m.user_id === viewerId);
  const otherSettings = other ? settings.byUser.get(other.user_id) : null;
  const profileVisible = other && canViewProfile(other.user_id, viewerId, otherSettings);
  const statusVisible = other && canViewStatus(other.user_id, viewerId, otherSettings);
  const allowedReactions = chat.allowed_reactions ? JSON.parse(chat.allowed_reactions) : null;
  return {
    id: chat.id,
    type: chat.type,
    title: chat.type === 'dm' ? (other?.name || 'Диалог') : chat.title,
    username: chat.username,
    description: chat.description,
    avatarUrl: chat.avatar_url ? signMedia(chat.avatar_url, 30 * 24 * 3600 * 1000) : null,
    bannerUrl: chat.banner_url ? signMedia(chat.banner_url, 30 * 24 * 3600 * 1000) : null,
    peer: other ? {
      id: other.user_id, name: other.name, username: other.username,
      avatarUrl: other.avatar_url ? signMedia(other.avatar_url, 30 * 24 * 3600 * 1000) : null,
      avatarColor: other.avatar_color,
      presence: statusVisible ? other.presence : null,
      lastSeen: statusVisible ? other.last_seen : null,
      bio: profileVisible ? other.bio : '',
      isBot: !!(other.is_bot ?? other.isBot), isPremium: !!other.is_premium,
      premiumBadge: other.is_premium ? (other.premium_badge || 'aurora') : null,
      premiumEmoji: other.is_premium ? (other.premium_emoji || null) : null,
    } : null,
    memberCount: members.length,
    muted: !!viewerMember?.muted,
    isPublic: !!chat.is_public,
    protectedContent: !!chat.protected_content,
    commentsEnabled: chat.comments_enabled !== 0,
    reactionsEnabled: chat.reactions_enabled !== 0,
    allowedReactions,
    joinApprovalRequired: chat.join_approval_required !== 0,
    ownerId: chat.owner_id,
    createdAt: chat.created_at,
    pinnedMessage: pinnedMsg ? { id: pinnedMsg.id, preview: String(pinnedMsg.text || '').slice(0, 120) || pinnedMsg.type } : null,
  };
}

export const uid = () => crypto.randomBytes(12).toString('base64url');

/* ───────────────────────── Проверки доступа ───────────────────────── */

export function requireMembership(chatId, userId) {
  const row = chats.memberOf.get(chatId, userId);
  if (!row) throw Object.assign(new Error('Нет доступа к этому чату'), { status: 403 });
  return row;
}

export function requireRole(chatId, userId, roles = ['owner', 'admin']) {
  const row = requireMembership(chatId, userId);
  if (!roles.includes(row.role)) throw Object.assign(new Error('Недостаточно прав'), { status: 403 });
  return row;
}

export const CHAT_ADMIN_PERMISSIONS = [
  'manage_info', 'publish', 'manage_members', 'manage_invites',
  'moderate', 'view_stats', 'pin_messages',
];

export function hasChatPermission(member, permission) {
  if (member?.role === 'owner') return true;
  if (member?.role !== 'admin') return false;
  const permissions = Array.isArray(member.permissions) ? member.permissions
    : member.permissions === null || member.permissions === undefined
      ? CHAT_ADMIN_PERMISSIONS : JSON.parse(member.permissions);
  return permissions.includes(permission);
}

export function requireChat(chatId) {
  const chat = chats.byId.get(chatId);
  if (!chat) throw Object.assign(new Error('Чат не найден'), { status: 404 });
  return chat;
}

/** Может ли пользователь писать в чат (канал — только админы, личка — с учётом блокировок и приватности). */
export function canPost(chat, memberRow, userId) {
  if (chat.type === 'channel') return hasChatPermission(memberRow, 'publish');
  if (chat.type === 'dm') {
    const members = chats.members.all(chat.id);
    const peer = members.find((m) => m.user_id !== userId);
    if (peer && blocks.isBlocked.get(peer.user_id, userId)) return false;
  }
  return true;
}

export function isBlockedPair(a, b) {
  return !!(blocks.isBlocked.get(a, b) || blocks.isBlocked.get(b, a));
}

export function chatsOf(userId) {
  return chats.userChatIds.all(userId).map((r) => r.chat_id);
}

export function membersOf(chatId) {
  return chats.members.all(chatId);
}

export function reactionRowsFor(messageIds) {
  if (!messageIds.length) return new Map();
  const map = new Map();
  const rows = reactions.bulkForMessages.all(JSON.stringify(messageIds));
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push(r);
  }
  return map;
}

export function publicUser(u, viewerId) {
  return userDTO(u, viewerId);
}

export function userByAny(idOrUsername) {
  if (/^\d+$/.test(String(idOrUsername))) return users.byId.get(Number(idOrUsername));
  return users.byUsername.get(String(idOrUsername || '').replace(/^@/, ''));
}
