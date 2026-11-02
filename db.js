/**
 * Слой данных: SQLite (better-sqlite3, WAL).
 * Изолирован от остального кода — замена на PostgreSQL потребует правки только этого файла.
 */
import Database from 'better-sqlite3';
import { DB_FILE, COMMERCE } from './config.js';

export const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  bio            TEXT NOT NULL DEFAULT '',
  status_text    TEXT NOT NULL DEFAULT '',
  avatar_url     TEXT,
  avatar_color   TEXT NOT NULL DEFAULT 'violet',
  profile_bg     TEXT,
  profile_banner TEXT,
  profile_banner_video_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  premium_badge   TEXT,
  premium_emoji   TEXT,
  profile_theme  TEXT NOT NULL DEFAULT 'aurora',
  profile_effects TEXT NOT NULL DEFAULT '{"theme":"none","ring":"none","nameFx":"none","dim":0}',
  profile_emoji  TEXT NOT NULL DEFAULT '✨',
  profile_text   TEXT NOT NULL DEFAULT '',
  profile_stickers TEXT NOT NULL DEFAULT '[]',
  personal_channel_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  presence       TEXT NOT NULL DEFAULT 'offline',
  last_seen      INTEGER NOT NULL DEFAULT 0,
  token_version  INTEGER NOT NULL DEFAULT 1,
  email_verified INTEGER NOT NULL DEFAULT 1,
  email_verification_deadline_at INTEGER,
  email_verification_requested_at INTEGER,
  protective_password_hash TEXT,
  protective_password_required INTEGER NOT NULL DEFAULT 0,
  is_bot         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS commerce_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme              TEXT NOT NULL DEFAULT 'dark',
  accent             TEXT NOT NULL DEFAULT 'ocean',
  font_scale         REAL NOT NULL DEFAULT 1,
  animations         INTEGER NOT NULL DEFAULT 1,
  compact            INTEGER NOT NULL DEFAULT 0,
  wallpaper          TEXT NOT NULL DEFAULT 'aurora',
  notify_messages    INTEGER NOT NULL DEFAULT 1,
  notify_groups      INTEGER NOT NULL DEFAULT 1,
  notify_channels    INTEGER NOT NULL DEFAULT 1,
  notify_sounds      INTEGER NOT NULL DEFAULT 1,
  notify_sound       TEXT NOT NULL DEFAULT 'default',
  notify_vibration   INTEGER NOT NULL DEFAULT 1,
  notify_preview     INTEGER NOT NULL DEFAULT 1,
  privacy_messages   TEXT NOT NULL DEFAULT 'everyone',
  privacy_profile    TEXT NOT NULL DEFAULT 'everyone',
  privacy_groups     TEXT NOT NULL DEFAULT 'everyone',
  privacy_status     TEXT NOT NULL DEFAULT 'everyone',
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('dm','group','channel')),
  title       TEXT,
  username    TEXT UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  avatar_url  TEXT,
  banner_url  TEXT,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_public   INTEGER NOT NULL DEFAULT 1,
  protected_content INTEGER NOT NULL DEFAULT 0,
  comments_enabled INTEGER NOT NULL DEFAULT 1,
  reactions_enabled INTEGER NOT NULL DEFAULT 1,
  allowed_reactions TEXT NOT NULL DEFAULT '',
  join_approval_required INTEGER NOT NULL DEFAULT 0,
  is_frozen   INTEGER NOT NULL DEFAULT 0,
  dm_key      TEXT UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id            INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  permissions        TEXT,
  joined_at          INTEGER NOT NULL,
  last_read_seq      INTEGER NOT NULL DEFAULT 0,
  last_delivered_seq INTEGER NOT NULL DEFAULT 0,
  muted              INTEGER NOT NULL DEFAULT 0,
  pinned             INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS chat_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_id INTEGER REFERENCES chat_invites(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_join_requests_pending
  ON chat_join_requests(chat_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_invites_chat ON chat_invites(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL COLLATE NOCASE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (chat_id, title)
);
CREATE INDEX IF NOT EXISTS idx_chat_topics_chat ON chat_topics(chat_id, is_default DESC, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  seq             INTEGER NOT NULL,
  type            TEXT NOT NULL DEFAULT 'text',
  text            TEXT NOT NULL DEFAULT '',
  media_id        INTEGER REFERENCES media(id) ON DELETE SET NULL,
  sticker         TEXT,
  reply_to        INTEGER,
  fwd_from_user   INTEGER,
  fwd_from_chat   INTEGER,
  scheduled_post_id INTEGER,
  topic_id        INTEGER REFERENCES chat_topics(id) ON DELETE SET NULL,
  edited_at       INTEGER,
  deleted_at      INTEGER,
  deleted_for_all INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  views           INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (chat_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_msg_chat_seq ON messages(chat_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_msg_chat_created ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_text ON messages(chat_id, deleted_for_all);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','published','cancelled','failed')),
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts(status, scheduled_at);

CREATE TABLE IF NOT EXISTS polls (
  message_id     INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  allow_multiple INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  duration   REAL,
  peaks      TEXT,
  path       TEXT NOT NULL,
  thumb_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('text','image','video')),
  text TEXT NOT NULL DEFAULT '',
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((type = 'text' AND media_id IS NULL) OR (type IN ('image','video') AND media_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_stories_owner_expiry ON stories(owner_id, expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_stories_expiry ON stories(expires_at);
CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, viewer_id)
);
CREATE TABLE IF NOT EXISTS story_likes (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
CREATE TABLE IF NOT EXISTS profile_gallery (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, media_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);

CREATE TABLE IF NOT EXISTS message_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  parent_comment_id INTEGER REFERENCES message_comments(id) ON DELETE SET NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_message_comments_message ON message_comments(message_id, id);
CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id INTEGER NOT NULL REFERENCES message_comments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user ON comment_likes(user_id, comment_id);

CREATE TABLE IF NOT EXISTS chat_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dismissed','message_removed','member_removed')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE (message_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_reports_pending ON chat_reports(chat_id, status, created_at);

CREATE TABLE IF NOT EXISTS message_media (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_message_media_message ON message_media(message_id, position);

CREATE TABLE IF NOT EXISTS hidden_messages (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_id, reported_id)
);

CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','issued','completed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status ON password_reset_requests(status, created_at DESC);
CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session ON push_subscriptions(session_id);
CREATE TABLE IF NOT EXISTS email_verifications (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash      TEXT NOT NULL,
  code_ciphertext TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_sent_at   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at, expires_at);
CREATE TABLE IF NOT EXISTS security_sso_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_security_sso_expiry ON security_sso_codes(expires_at, redeemed_at);
CREATE TABLE IF NOT EXISTS registration_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  personal_data_consent INTEGER NOT NULL CHECK (personal_data_consent IN (0, 1)),
  age_guardian_attested INTEGER NOT NULL CHECK (age_guardian_attested IN (0, 1)),
  accepted_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_registration_consents_user ON registration_consents(user_id, accepted_at DESC);
CREATE TABLE IF NOT EXISTS native_push_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_push_tokens_user ON native_push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_native_push_tokens_session ON native_push_tokens(session_id);

CREATE TABLE IF NOT EXISTS user_two_factor (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aurora_wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS aurora_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aurora_transactions_user ON aurora_transactions(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS premium_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL DEFAULT 'demo',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_premium_user ON premium_subscriptions(user_id, expires_at DESC);
CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('auroras', 'premium')),
  product_id TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'RUB'),
  provider TEXT NOT NULL DEFAULT 'yookassa',
  provider_mode TEXT NOT NULL DEFAULT 'test' CHECK (provider_mode IN ('test', 'live')),
  provider_payment_id TEXT UNIQUE,
  confirmation_url TEXT,
  idempotency_key TEXT NOT NULL,
  receipt_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'pending', 'succeeded', 'canceled')),
  provider_status TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  paid_at INTEGER,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  emoji TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  animation TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  rarity TEXT NOT NULL DEFAULT 'обычный',
  image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS gift_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  auroras INTEGER NOT NULL,
  price INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'demo',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS received_gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_id TEXT NOT NULL REFERENCES gifts(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'owned',
  is_hidden INTEGER NOT NULL DEFAULT 0,
  pinned_order INTEGER,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_received_gifts_recipient ON received_gifts(recipient_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gift_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_instance_id INTEGER REFERENCES received_gifts(id) ON DELETE SET NULL,
  gift_id TEXT NOT NULL REFERENCES gifts(id),
  operation TEXT NOT NULL,
  other_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_history_user ON gift_history(user_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS gift_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key)
);

/** Журнал событий: страховка синхронизации, когда WebSocket недоступен. */
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope, id);
`;

db.exec(SCHEMA);
db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL UNIQUE,
  started_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_mode TEXT NOT NULL CHECK (media_mode IN ('audio','video')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_chat_active ON calls(chat_id, status, started_at DESC);
CREATE TABLE IF NOT EXISTS call_participants (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('invited','joined','declined','left','missed')),
  invited_at INTEGER NOT NULL,
  joined_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id, invited_at DESC);
`);

/** Простые миграции для уже существующих баз (без внешних инструментов). */
function migrate() {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const commentCols = cols('message_comments');
  if (!commentCols.includes('parent_comment_id')) {
    db.exec('ALTER TABLE message_comments ADD COLUMN parent_comment_id INTEGER REFERENCES message_comments(id) ON DELETE SET NULL');
  }
  if (!commentCols.includes('edited_at')) db.exec('ALTER TABLE message_comments ADD COLUMN edited_at INTEGER');
  if (!commentCols.includes('deleted_at')) db.exec('ALTER TABLE message_comments ADD COLUMN deleted_at INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS comment_likes (
    comment_id INTEGER NOT NULL REFERENCES message_comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (comment_id, user_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_comment_likes_user ON comment_likes(user_id, comment_id)');
  const reactionPk = db.prepare('PRAGMA table_info(reactions)').all()
    .filter((column) => column.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  if (reactionPk.join(',') !== 'message_id,user_id,emoji') {
    db.transaction(() => {
      db.exec(`CREATE TABLE reactions_migrated (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      )`);
      db.exec(`INSERT INTO reactions_migrated (message_id, user_id, emoji, created_at)
        SELECT message_id, user_id, emoji, created_at FROM reactions`);
      db.exec('DROP TABLE reactions');
      db.exec('ALTER TABLE reactions_migrated RENAME TO reactions');
      db.exec('CREATE INDEX idx_reactions_msg ON reactions(message_id)');
    })();
  }
  const mediaCols = cols('media');
  if (!mediaCols.includes('thumb_path')) db.exec('ALTER TABLE media ADD COLUMN thumb_path TEXT');
  const chatCols = cols('chats');
  const giftCols = cols('gifts');
  if (giftCols.length && !giftCols.includes('is_active')) db.exec('ALTER TABLE gifts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  if (giftCols.length && !giftCols.includes('rarity')) db.exec("ALTER TABLE gifts ADD COLUMN rarity TEXT NOT NULL DEFAULT 'обычный'");
  if (giftCols.length && !giftCols.includes('image_media_id')) db.exec('ALTER TABLE gifts ADD COLUMN image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL');
  if (giftCols.length && !giftCols.includes('stock_total')) db.exec('ALTER TABLE gifts ADD COLUMN stock_total INTEGER');
  if (giftCols.length && !giftCols.includes('stock_remaining')) db.exec('ALTER TABLE gifts ADD COLUMN stock_remaining INTEGER');
  if (giftCols.length && !giftCols.includes('sellback_percent')) db.exec('ALTER TABLE gifts ADD COLUMN sellback_percent INTEGER NOT NULL DEFAULT 50');
  if (giftCols.length && !giftCols.includes('created_at')) db.exec('ALTER TABLE gifts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
  if (giftCols.length && !giftCols.includes('updated_at')) db.exec('ALTER TABLE gifts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
  const receivedGiftCols = cols('received_gifts');
  if (receivedGiftCols.length && !receivedGiftCols.includes('status')) db.exec("ALTER TABLE received_gifts ADD COLUMN status TEXT NOT NULL DEFAULT 'owned'");
  if (receivedGiftCols.length && !receivedGiftCols.includes('is_hidden')) db.exec('ALTER TABLE received_gifts ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0');
  if (receivedGiftCols.length && !receivedGiftCols.includes('pinned_order')) db.exec('ALTER TABLE received_gifts ADD COLUMN pinned_order INTEGER');
  if (receivedGiftCols.length && !receivedGiftCols.includes('idempotency_key')) db.exec('ALTER TABLE received_gifts ADD COLUMN idempotency_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_received_gifts_sender_idempotency ON received_gifts(sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
  if (!chatCols.includes('pinned_msg')) db.exec('ALTER TABLE chats ADD COLUMN pinned_msg INTEGER');
  if (!chatCols.includes('banner_url')) db.exec('ALTER TABLE chats ADD COLUMN banner_url TEXT');
  if (!chatCols.includes('protected_content')) db.exec('ALTER TABLE chats ADD COLUMN protected_content INTEGER NOT NULL DEFAULT 0');
  if (!chatCols.includes('comments_enabled')) db.exec('ALTER TABLE chats ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 1');
  if (!chatCols.includes('reactions_enabled')) db.exec('ALTER TABLE chats ADD COLUMN reactions_enabled INTEGER NOT NULL DEFAULT 1');
  if (!chatCols.includes('allowed_reactions')) db.exec("ALTER TABLE chats ADD COLUMN allowed_reactions TEXT NOT NULL DEFAULT ''");
  if (!chatCols.includes('join_approval_required')) db.exec('ALTER TABLE chats ADD COLUMN join_approval_required INTEGER NOT NULL DEFAULT 0');
  if (!chatCols.includes('is_frozen')) db.exec('ALTER TABLE chats ADD COLUMN is_frozen INTEGER NOT NULL DEFAULT 0');
  const userCols = cols('users');
  const messageCols = cols('messages');
  if (!messageCols.includes('scheduled_post_id')) db.exec('ALTER TABLE messages ADD COLUMN scheduled_post_id INTEGER');
  if (!messageCols.includes('topic_id')) db.exec('ALTER TABLE messages ADD COLUMN topic_id INTEGER REFERENCES chat_topics(id) ON DELETE SET NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_scheduled_post ON messages(scheduled_post_id) WHERE scheduled_post_id IS NOT NULL');
  db.exec(`INSERT OR IGNORE INTO chat_topics (chat_id, title, created_by, is_default, created_at)
    SELECT id, 'Общие', owner_id, 1, created_at FROM chats WHERE type = 'group'`);
  db.exec(`UPDATE messages SET topic_id = (
    SELECT id FROM chat_topics WHERE chat_topics.chat_id = messages.chat_id AND is_default = 1
  ) WHERE topic_id IS NULL AND chat_id IN (SELECT id FROM chats WHERE type = 'group')`);
  const memberCols = cols('chat_members');
  if (!memberCols.includes('permissions')) db.exec('ALTER TABLE chat_members ADD COLUMN permissions TEXT');
  if (!userCols.includes('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  if (!userCols.includes('email_verification_deadline_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verification_deadline_at INTEGER');
    db.exec('UPDATE users SET email_verified = 1 WHERE email_verified = 0');
  }
  if (!userCols.includes('email_verification_requested_at')) db.exec('ALTER TABLE users ADD COLUMN email_verification_requested_at INTEGER');
  if (!userCols.includes('protective_password_hash')) db.exec('ALTER TABLE users ADD COLUMN protective_password_hash TEXT');
  if (!userCols.includes('protective_password_required')) {
    db.exec('ALTER TABLE users ADD COLUMN protective_password_required INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE users SET protective_password_required = 1');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS email_verifications (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, code_ciphertext TEXT NOT NULL,
    expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  const verificationCols = cols('email_verifications');
  if (!verificationCols.includes('code_ciphertext')) {
    db.exec("ALTER TABLE email_verifications ADD COLUMN code_ciphertext TEXT NOT NULL DEFAULT ''");
  }
  if (!userCols.includes('profile_banner')) db.exec('ALTER TABLE users ADD COLUMN profile_banner TEXT');
  if (!userCols.includes('profile_banner_video_media_id')) db.exec('ALTER TABLE users ADD COLUMN profile_banner_video_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL');
  if (!userCols.includes('premium_badge')) db.exec('ALTER TABLE users ADD COLUMN premium_badge TEXT');
  if (!userCols.includes('premium_emoji')) db.exec('ALTER TABLE users ADD COLUMN premium_emoji TEXT');
  if (!userCols.includes('profile_theme')) db.exec("ALTER TABLE users ADD COLUMN profile_theme TEXT NOT NULL DEFAULT 'aurora'");
  if (!userCols.includes('profile_effects')) db.exec(`ALTER TABLE users ADD COLUMN profile_effects TEXT NOT NULL DEFAULT '{"theme":"none","ring":"none","nameFx":"none","dim":0}'`);
  if (!userCols.includes('profile_emoji')) db.exec("ALTER TABLE users ADD COLUMN profile_emoji TEXT NOT NULL DEFAULT '✨'");
  if (!userCols.includes('profile_text')) db.exec("ALTER TABLE users ADD COLUMN profile_text TEXT NOT NULL DEFAULT ''");
  if (!userCols.includes('profile_stickers')) db.exec("ALTER TABLE users ADD COLUMN profile_stickers TEXT NOT NULL DEFAULT '[]'");
  if (!userCols.includes('personal_channel_id')) db.exec('ALTER TABLE users ADD COLUMN personal_channel_id INTEGER REFERENCES chats(id) ON DELETE SET NULL');
  if (!userCols.includes('is_bot')) db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0');
  if (!userCols.includes('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  if (!userCols.includes('is_blocked')) db.exec('ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0');
  if (!userCols.includes('is_frozen')) db.exec('ALTER TABLE users ADD COLUMN is_frozen INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS profile_gallery (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, media_id)
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS commerce_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  migrateCommerceCatalog();
  const paymentOrderCols = cols('payment_orders');
  if (!paymentOrderCols.includes('provider_mode')) {
    db.exec("ALTER TABLE payment_orders ADD COLUMN provider_mode TEXT NOT NULL DEFAULT 'test'");
  }
  if (!paymentOrderCols.includes('receipt_email')) {
    db.exec("ALTER TABLE payment_orders ADD COLUMN receipt_email TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_hidden_user ON hidden_messages(user_id)');
  const settingCols = cols('settings');
  if (!settingCols.includes('notify_sound')) db.exec("ALTER TABLE settings ADD COLUMN notify_sound TEXT NOT NULL DEFAULT 'default'");
  db.exec(`CREATE TABLE IF NOT EXISTS support_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_badges (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge TEXT NOT NULL,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, badge)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS polls (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question TEXT NOT NULL, options_json TEXT NOT NULL, allow_multiple INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
    message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, option_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    revoked_at INTEGER, user_agent TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT ''
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at, expires_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS user_two_factor (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS aurora_wallets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0), updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS aurora_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL,
    reference_type TEXT, reference_id TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_aurora_transactions_user ON aurora_transactions(user_id, created_at DESC)');
  db.exec(`CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', provider TEXT NOT NULL DEFAULT 'demo', created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_premium_user ON premium_subscriptions(user_id, expires_at DESC)');
  db.exec(`CREATE TABLE IF NOT EXISTS gifts (
    id TEXT PRIMARY KEY, emoji TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
    price INTEGER NOT NULL, animation TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS gift_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id TEXT NOT NULL, auroras INTEGER NOT NULL, price INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'demo', created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS received_gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, gift_id TEXT NOT NULL REFERENCES gifts(id),
    sender_id INTEGER NOT NULL REFERENCES users(id), recipient_id INTEGER NOT NULL REFERENCES users(id),
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL, note TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'owned',
    is_hidden INTEGER NOT NULL DEFAULT 0, pinned_order INTEGER, idempotency_key TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_received_gifts_recipient ON received_gifts(recipient_id, created_at DESC)');
  const insertGift = db.prepare('INSERT OR IGNORE INTO gifts (id, emoji, name, description, price, animation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const gift of COMMERCE.gifts) insertGift.run(gift.id, gift.emoji, gift.name, gift.description, gift.price, gift.animation, Date.now(), Date.now());
}

function migrateCommerceCatalog() {
  const legacyPrices = {
    balancePackages: new Map([
      ['aurora-100', 99],
      ['aurora-500', 399],
      ['aurora-1000', 699],
      ['aurora-2500', 1499],
    ]),
    premiumPlans: new Map([
      ['premium-1m', 299],
      ['premium-3m', 799],
      ['premium-12m', 2499],
    ]),
  };
  const updates = {
    balancePackages: new Map([
      ['aurora-100', 10],
      ['aurora-500', 279],
      ['aurora-1000', 589],
      ['aurora-2500', 1399],
    ]),
    premiumPlans: new Map([
      ['premium-1m', 99],
      ['premium-3m', 289],
      ['premium-6m', 589],
      ['premium-12m', 1099],
    ]),
  };

  for (const key of ['balancePackages', 'premiumPlans']) {
    const row = db.prepare('SELECT value FROM commerce_config WHERE key = ?').get(key);
    if (!row) continue;

    let items;
    try {
      items = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;

    let changed = false;
    const next = items
      .filter((item) => key !== 'balancePackages' || !['aurora-5000', 'aurora-10000'].includes(item?.id))
      .map((item) => {
        const oldPrice = legacyPrices[key].get(item?.id);
        const newPrice = updates[key].get(item?.id);
        const newAuroraPrice = key === 'balancePackages'
          && item?.id === 'aurora-100'
          && [59, 99].includes(item.price)
          && item.currency === 'RUB';
        if (newPrice !== undefined && item.currency === 'RUB'
          && (newAuroraPrice || (oldPrice !== undefined && item.price === oldPrice))) {
          changed = true;
          return { ...item, price: newPrice };
        }
        return item;
      });

    if (key === 'premiumPlans' && !next.some((item) => item?.id === 'premium-6m')) {
      const threeMonthPlan = next.findIndex((item) => item?.id === 'premium-3m');
      next.splice(threeMonthPlan < 0 ? next.length : threeMonthPlan + 1, 0, {
        id: 'premium-6m', months: 6, price: 589, currency: 'RUB',
      });
      changed = true;
    }
    if (next.length !== items.length) changed = true;
    if (changed) {
      db.prepare('UPDATE commerce_config SET value = ? WHERE key = ?').run(JSON.stringify(next), key);
    }
  }
}

migrate();

export const now = () => Date.now();

/* ─────────────────────────── Пользователи ─────────────────────────── */

export const users = {
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  byUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  byBotUsername: db.prepare('SELECT * FROM users WHERE username = ? AND is_bot = 1'),
  markBot: db.prepare('UPDATE users SET is_bot = 1 WHERE id = ?'),
  create: db.prepare(`INSERT INTO users (email, username, name, password_hash, bio, avatar_url, avatar_color, email_verified,
                      email_verification_deadline_at, created_at, updated_at)
                      VALUES (@email, @username, @name, @password_hash, @bio, @avatar_url, @avatar_color, @email_verified,
                      @email_verification_deadline_at, @created_at, @updated_at)`),
  setEmailVerificationRequestedAt: db.prepare('UPDATE users SET email_verification_requested_at = ?, updated_at = ? WHERE id = ?'),
  changeEmail: db.prepare(`UPDATE users SET email = ?, email_verified = 0,
    email_verification_deadline_at = ?, email_verification_requested_at = NULL, updated_at = ? WHERE id = ?`),
  verifyEmail: db.prepare(`UPDATE users SET email_verified = 1, email_verification_deadline_at = NULL,
    email_verification_requested_at = NULL, updated_at = ? WHERE id = ? AND email_verified = 0`),
  update: db.prepare(`UPDATE users SET name = COALESCE(@name, name), username = COALESCE(@username, username),
                      bio = COALESCE(@bio, bio), status_text = COALESCE(@status_text, status_text),
                      avatar_color = COALESCE(@avatar_color, avatar_color),
                      updated_at = @updated_at WHERE id = @id`),
  touchUsername: db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?'),
  setPresence: db.prepare('UPDATE users SET presence = ?, last_seen = ? WHERE id = ?'),
  bumpTokenVersion: db.prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?'),
  setProtectivePassword: db.prepare('UPDATE users SET protective_password_hash = ?, protective_password_required = 0, updated_at = ? WHERE id = ?'),
  clearProtectivePassword: db.prepare('UPDATE users SET protective_password_hash = NULL, protective_password_required = ?, updated_at = ? WHERE id = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?'),
  setProfileBg: db.prepare('UPDATE users SET profile_bg = ?, updated_at = ? WHERE id = ?'),
  setPremiumBadge: db.prepare('UPDATE users SET premium_badge = ?, updated_at = ? WHERE id = ?'),
  setPremiumEmoji: db.prepare('UPDATE users SET premium_emoji = ?, updated_at = ? WHERE id = ?'),
  setProfileEffects: db.prepare('UPDATE users SET profile_effects = ?, updated_at = ? WHERE id = ?'),
  setProfileBannerVideo: db.prepare('UPDATE users SET profile_banner_video_media_id = ?, updated_at = ? WHERE id = ?'),
  setProfileStyle: db.prepare(`UPDATE users SET profile_banner = CASE WHEN @profile_banner_set THEN @profile_banner ELSE profile_banner END,
    profile_theme = COALESCE(@profile_theme, profile_theme), profile_emoji = COALESCE(@profile_emoji, profile_emoji),
    profile_text = COALESCE(@profile_text, profile_text), profile_stickers = COALESCE(@profile_stickers, profile_stickers),
    personal_channel_id = COALESCE(@personal_channel_id, personal_channel_id), updated_at = @updated_at WHERE id = @id`),
  clearPersonalChannel: db.prepare('UPDATE users SET personal_channel_id = NULL, updated_at = ? WHERE id = ?'),
  gallery: db.prepare('SELECT m.* FROM profile_gallery g JOIN media m ON m.id = g.media_id WHERE g.user_id = ? ORDER BY g.position, g.media_id'),
  galleryAdd: db.prepare('INSERT OR IGNORE INTO profile_gallery (user_id, media_id, position) VALUES (?, ?, ?)'),
  galleryRemove: db.prepare('DELETE FROM profile_gallery WHERE user_id = ? AND media_id = ?'),
  galleryCount: db.prepare('SELECT COUNT(*) AS c FROM profile_gallery WHERE user_id = ?'),
  search: db.prepare(`SELECT * FROM users
                      WHERE username LIKE @q OR name LIKE @q OR email LIKE @q ORDER BY name LIMIT 30`),
};

export const sessions = {
  create: db.prepare(`INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, user_agent, ip)
    VALUES (@id, @user_id, @created_at, @last_seen, @expires_at, @user_agent, @ip)`),
  active: db.prepare('SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?'),
  byUser: db.prepare('SELECT id, created_at, last_seen, expires_at, user_agent, ip FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC'),
  revoke: db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'),
  revokeAll: db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'),
  touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ? AND revoked_at IS NULL'),
};

export const securitySsoCodes = {
  create: db.prepare(`INSERT INTO security_sso_codes (code_hash, user_id, created_at, expires_at)
    VALUES (@code_hash, @user_id, @created_at, @expires_at)`),
  active: db.prepare(`SELECT c.code_hash, c.user_id, u.email, u.name, u.email_verified, u.is_admin, u.is_blocked, u.is_frozen
    FROM security_sso_codes c JOIN users u ON u.id = c.user_id
    WHERE c.code_hash = ? AND c.redeemed_at IS NULL AND c.expires_at > ?`),
  redeem: db.prepare('UPDATE security_sso_codes SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?'),
  removeExpired: db.prepare('DELETE FROM security_sso_codes WHERE expires_at <= ? OR redeemed_at IS NOT NULL'),
};

export const twoFactor = {
  byUser: db.prepare('SELECT * FROM user_two_factor WHERE user_id = ?'),
  save: db.prepare(`INSERT INTO user_two_factor (user_id, secret, enabled, recovery_codes, created_at, updated_at)
    VALUES (@user_id, @secret, @enabled, @recovery_codes, @created_at, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET secret=@secret, enabled=@enabled, recovery_codes=@recovery_codes, updated_at=@updated_at`),
  setEnabled: db.prepare('UPDATE user_two_factor SET enabled = ?, updated_at = ? WHERE user_id = ?'),
  updateCodes: db.prepare('UPDATE user_two_factor SET recovery_codes = ?, updated_at = ? WHERE user_id = ?'),
  remove: db.prepare('DELETE FROM user_two_factor WHERE user_id = ?'),
};

export const settings = {
  create: db.prepare('INSERT OR IGNORE INTO settings (user_id, updated_at) VALUES (?, ?)'),
  byUser: db.prepare('SELECT * FROM settings WHERE user_id = ?'),
  updateWallpaper: db.prepare('UPDATE settings SET wallpaper = ?, updated_at = ? WHERE user_id = ?'),
  update: db.prepare(`UPDATE settings SET
      theme = COALESCE(@theme, theme), accent = COALESCE(@accent, accent), font_scale = COALESCE(@font_scale, font_scale),
      animations = COALESCE(@animations, animations), compact = COALESCE(@compact, compact), wallpaper = COALESCE(@wallpaper, wallpaper),
      notify_messages = COALESCE(@notify_messages, notify_messages), notify_groups = COALESCE(@notify_groups, notify_groups),
      notify_channels = COALESCE(@notify_channels, notify_channels), notify_sounds = COALESCE(@notify_sounds, notify_sounds),
      notify_sound = COALESCE(@notify_sound, notify_sound),
      notify_vibration = COALESCE(@notify_vibration, notify_vibration), notify_preview = COALESCE(@notify_preview, notify_preview),
      privacy_messages = COALESCE(@privacy_messages, privacy_messages), privacy_profile = COALESCE(@privacy_profile, privacy_profile),
      privacy_groups = COALESCE(@privacy_groups, privacy_groups), privacy_status = COALESCE(@privacy_status, privacy_status),
      updated_at = @updated_at
    WHERE user_id = @user_id`),
};

/* ─────────────────────────── Чаты / участники ─────────────────────────── */

export const chats = {
  byId: db.prepare('SELECT * FROM chats WHERE id = ?'),
  byUsername: db.prepare('SELECT * FROM chats WHERE username = ? COLLATE NOCASE'),
  byDmKey: db.prepare("SELECT * FROM chats WHERE dm_key = ?"),
  dmList: db.prepare("SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE c.type = 'dm' AND m.user_id = ?"),
  securityList: db.prepare(`SELECT c.id, c.type, c.title, c.username, c.description, c.is_public, c.is_frozen,
      c.created_at, COUNT(cm.user_id) AS member_count
    FROM chats c LEFT JOIN chat_members cm ON cm.chat_id = c.id
    WHERE c.type IN ('group', 'channel') AND (@type = 'all' OR c.type = @type)
      AND (@cursor IS NULL OR c.id < @cursor)
    GROUP BY c.id
    ORDER BY c.id DESC
    LIMIT @limit`),
  create: db.prepare(`INSERT INTO chats (type, title, username, description, avatar_url, owner_id, is_public, dm_key, created_at)
                      VALUES (@type, @title, @username, @description, @avatar_url, @owner_id, @is_public, @dm_key, @created_at)`),
  createDefaultTopic: db.prepare(`INSERT INTO chat_topics (chat_id, title, created_by, is_default, created_at)
    VALUES (?, 'Общие', ?, 1, ?)`),
  update: db.prepare(`UPDATE chats SET title = COALESCE(@title, title), description = COALESCE(@description, description),
                      avatar_url = COALESCE(@avatar_url, avatar_url), banner_url = COALESCE(@banner_url, banner_url),
                      username = COALESCE(@username, username), is_public = COALESCE(@is_public, is_public),
                      protected_content = COALESCE(@protected_content, protected_content),
                      comments_enabled = COALESCE(@comments_enabled, comments_enabled),
                      reactions_enabled = COALESCE(@reactions_enabled, reactions_enabled),
                      allowed_reactions = COALESCE(@allowed_reactions, allowed_reactions),
                      join_approval_required = COALESCE(@join_approval_required, join_approval_required) WHERE id = @id`),
  delete: db.prepare('DELETE FROM chats WHERE id = ?'),
  /** Список чатов пользователя + краткая сводка (последнее сообщение, счётчики, pinned). */
  listForUser: db.prepare(`
    SELECT c.id, c.type, c.title, c.username, c.description, c.avatar_url, c.owner_id, c.is_public, c.created_at,
           m.role, m.last_read_seq, m.pinned, m.muted, m.archived, m.joined_at,
           (SELECT id      FROM messages x WHERE x.chat_id = c.id AND x.deleted_for_all = 0 AND x.id NOT IN (SELECT message_id FROM hidden_messages h WHERE h.user_id = @uid) ORDER BY x.seq DESC LIMIT 1) AS last_id,
           (SELECT text    FROM messages x WHERE x.chat_id = c.id AND x.deleted_for_all = 0 ORDER BY x.seq DESC LIMIT 1) AS last_text,
           (SELECT type    FROM messages x WHERE x.chat_id = c.id AND x.deleted_for_all = 0 ORDER BY x.seq DESC LIMIT 1) AS last_type,
           (SELECT sticker FROM messages x WHERE x.chat_id = c.id AND x.deleted_for_all = 0 ORDER BY x.seq DESC LIMIT 1) AS last_sticker,
           (SELECT media_id FROM messages x WHERE x.chat_id = c.id AND x.deleted_for_all = 0 ORDER BY x.seq DESC LIMIT 1) AS last_media_id,
           (SELECT sender_id FROM messages x WHERE x.chat_id = c.id AND x.deleted_for_all = 0 ORDER BY x.seq DESC LIMIT 1) AS last_sender_id,
           (SELECT created_at FROM messages x WHERE x.chat_id = c.id AND x.deleted_for_all = 0 ORDER BY x.seq DESC LIMIT 1) AS last_at,
           (SELECT seq     FROM messages x WHERE x.chat_id = c.id ORDER BY x.seq DESC LIMIT 1) AS last_seq,
           (SELECT COUNT(*) FROM messages x WHERE x.chat_id = c.id AND x.seq > m.last_read_seq AND x.sender_id <> @uid AND x.deleted_for_all = 0
              AND x.id NOT IN (SELECT message_id FROM hidden_messages h WHERE h.user_id = @uid)) AS unread,
           (SELECT COUNT(*) FROM chat_members cm2 WHERE cm2.chat_id = c.id) AS member_count,
           (SELECT COUNT(*) FROM messages x WHERE x.chat_id = c.id AND x.pinned = 1 AND x.deleted_for_all = 0) AS pinned_count
    FROM chats c
    JOIN chat_members m ON m.chat_id = c.id AND m.user_id = @uid
    ORDER BY m.pinned DESC, COALESCE(last_at, c.created_at) DESC
    LIMIT @limit`),
  /** Быстрый доступ к участникам (для ACL и рассылки событий). */
  members: db.prepare(`SELECT cm.user_id, cm.role, cm.permissions, cm.muted, cm.pinned, cm.last_read_seq, cm.last_delivered_seq,
                              u.name, u.username, u.avatar_url, u.avatar_color, u.presence, u.last_seen, u.email, u.bio, u.status_text, u.is_bot, u.premium_badge, u.premium_emoji, u.created_at AS user_created_at,
                              EXISTS(SELECT 1 FROM premium_subscriptions ps WHERE ps.user_id = u.id AND ps.status = 'active' AND ps.expires_at > strftime('%s','now') * 1000) AS is_premium
                       FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY
                       CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`),
  memberIds: db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?'),
  memberOf: db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?'),
  addMember: db.prepare(`INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at, last_read_seq) VALUES (?, ?, ?, ?, ?)`),
  removeMember: db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?'),
  setRole: db.prepare('UPDATE chat_members SET role = ?, permissions = ? WHERE chat_id = ? AND user_id = ?'),
  setFlags: db.prepare(`UPDATE chat_members SET muted = COALESCE(@muted, muted), pinned = COALESCE(@pinned, pinned),
                        archived = COALESCE(@archived, archived) WHERE chat_id = @chat_id AND user_id = @user_id`),
  setReadSeq: db.prepare(`UPDATE chat_members SET last_read_seq = MAX(last_read_seq, ?) WHERE chat_id = ? AND user_id = ?`),
  setDeliveredSeq: db.prepare(`UPDATE chat_members SET last_delivered_seq = MAX(last_delivered_seq, ?) WHERE chat_id = ? AND user_id = ?`),
  minOtherReadSeq: db.prepare('SELECT MIN(last_read_seq) AS m FROM chat_members WHERE chat_id = ? AND user_id <> ?'),
  userChatIds: db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?'),
  dmKeysBetween: db.prepare("SELECT id FROM chats WHERE dm_key IN (?, ?)"),
};

export const chatInvites = {
  byToken: db.prepare(`SELECT ci.*, c.type AS chat_type, c.title, c.is_public
    FROM chat_invites ci JOIN chats c ON c.id = ci.chat_id
    WHERE ci.token_hash = ?`),
  list: db.prepare(`SELECT id, chat_id, created_by, max_uses, use_count, expires_at, revoked_at, created_at
    FROM chat_invites WHERE chat_id = ? ORDER BY created_at DESC`),
  create: db.prepare(`INSERT INTO chat_invites
    (chat_id, token_hash, created_by, max_uses, expires_at, created_at)
    VALUES (@chat_id, @token_hash, @created_by, @max_uses, @expires_at, @created_at)`),
  consume: db.prepare(`UPDATE chat_invites SET use_count = use_count + 1
    WHERE id = @id AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > @now)
      AND (max_uses IS NULL OR use_count < max_uses)`),
  revoke: db.prepare(`UPDATE chat_invites SET revoked_at = ?
    WHERE id = ? AND chat_id = ? AND revoked_at IS NULL`),
  byId: db.prepare('SELECT * FROM chat_invites WHERE id = ? AND chat_id = ?'),
};

export const chatJoinRequests = {
  byId: db.prepare('SELECT * FROM chat_join_requests WHERE id = ? AND chat_id = ?'),
  get: db.prepare('SELECT * FROM chat_join_requests WHERE chat_id = ? AND user_id = ?'),
  listPending: db.prepare(`SELECT r.id, r.chat_id, r.user_id, r.invite_id, r.created_at,
      u.name, u.username, u.avatar_url, u.avatar_color, u.bio
    FROM chat_join_requests r JOIN users u ON u.id = r.user_id
    WHERE r.chat_id = ? AND r.status = 'pending'
    ORDER BY r.created_at ASC LIMIT 200`),
  upsert: db.prepare(`INSERT INTO chat_join_requests (chat_id, user_id, invite_id, status, created_at, updated_at)
    VALUES (@chat_id, @user_id, @invite_id, 'pending', @now, @now)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET invite_id = excluded.invite_id,
      status = 'pending', updated_at = excluded.updated_at
    WHERE chat_join_requests.status <> 'pending'`),
  decide: db.prepare(`UPDATE chat_join_requests SET status = @status, updated_at = @now
    WHERE id = @id AND chat_id = @chat_id AND status = 'pending'`),
};

export const chatReports = {
  create: db.prepare(`INSERT INTO chat_reports (chat_id, message_id, reporter_id, reason, details, created_at)
    VALUES (@chat_id, @message_id, @reporter_id, @reason, @details, @created_at)`),
  listPending: db.prepare(`SELECT r.id, r.message_id, r.reporter_id, r.reason, r.details, r.created_at,
      report_user.name AS reporter_name, report_user.username AS reporter_username,
      m.sender_id AS author_id, author.name AS author_name, author.username AS author_username,
      substr(m.text, 1, 300) AS message_text, m.type AS message_type
    FROM chat_reports r JOIN messages m ON m.id = r.message_id
    JOIN users report_user ON report_user.id = r.reporter_id
    LEFT JOIN users author ON author.id = m.sender_id
    WHERE r.chat_id = ? AND r.status = 'pending'
    ORDER BY r.created_at ASC LIMIT 200`),
  byId: db.prepare('SELECT * FROM chat_reports WHERE id = ? AND chat_id = ?'),
  decide: db.prepare(`UPDATE chat_reports SET status = @status, reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
    WHERE id = @id AND chat_id = @chat_id AND status = 'pending'`),
};

export const chatTopics = {
  byId: db.prepare('SELECT * FROM chat_topics WHERE id = ? AND chat_id = ?'),
  list: db.prepare('SELECT * FROM chat_topics WHERE chat_id = ? ORDER BY is_default DESC, created_at ASC'),
  defaultByChat: db.prepare('SELECT id FROM chat_topics WHERE chat_id = ? AND is_default = 1'),
  count: db.prepare('SELECT COUNT(*) AS count FROM chat_topics WHERE chat_id = ?'),
  create: db.prepare(`INSERT INTO chat_topics (chat_id, title, created_by, created_at)
    VALUES (@chat_id, @title, @created_by, @created_at)`),
  setClosed: db.prepare('UPDATE chat_topics SET is_closed = ? WHERE id = ? AND chat_id = ? AND is_default = 0'),
  messagesCount: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?'),
};

export const messages = {
  byId: db.prepare('SELECT * FROM messages WHERE id = ?'),
  isHidden: db.prepare('SELECT 1 AS hidden FROM hidden_messages WHERE message_id = ? AND user_id = ?'),
  maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE chat_id = ?'),
  create: db.prepare(`INSERT INTO messages (chat_id, sender_id, seq, type, text, media_id, sticker, reply_to, fwd_from_user, fwd_from_chat, scheduled_post_id, topic_id, created_at)
                      VALUES (@chat_id, @sender_id, @seq, @type, @text, @media_id, @sticker, @reply_to, @fwd_from_user, @fwd_from_chat, @scheduled_post_id, @topic_id, @created_at)`),
  byScheduledPost: db.prepare('SELECT * FROM messages WHERE scheduled_post_id = ?'),
  page: db.prepare(`SELECT * FROM messages WHERE chat_id = @chat_id AND seq < @before AND deleted_for_all = 0
                    AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = @uid)
                    ORDER BY seq DESC LIMIT @limit`),
  pageInTopic: db.prepare(`SELECT * FROM messages WHERE chat_id = @chat_id AND topic_id = @topic_id
                    AND seq < @before AND deleted_for_all = 0
                    AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = @uid)
                    ORDER BY seq DESC LIMIT @limit`),
  around: db.prepare(`SELECT * FROM messages WHERE chat_id = @chat_id AND deleted_for_all = 0 ORDER BY seq DESC LIMIT @limit`),
  after: db.prepare(`SELECT * FROM messages WHERE chat_id = @chat_id AND seq > @seq AND deleted_for_all = 0
                     AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = @uid)
                     ORDER BY seq ASC LIMIT @limit`),
  afterInTopic: db.prepare(`SELECT * FROM messages WHERE chat_id = @chat_id AND topic_id = @topic_id
                     AND seq > @seq AND deleted_for_all = 0
                     AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = @uid)
                     ORDER BY seq ASC LIMIT @limit`),
  updateText: db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?'),
  setDeletedAll: db.prepare('UPDATE messages SET deleted_for_all = 1, text = \'\', media_id = NULL, sticker = NULL, pinned = 0, edited_at = ? WHERE id = ?'),
  removeMessageMedia: db.prepare('DELETE FROM message_media WHERE message_id = ?'),
  pin: db.prepare('UPDATE messages SET pinned = ? WHERE id = ?'),
  bumpViews: db.prepare('UPDATE messages SET views = views + 1 WHERE id = ?'),
  addMessageMedia: db.prepare('INSERT OR IGNORE INTO message_media (message_id, media_id, position) VALUES (?, ?, ?)'),
  messageMedia: db.prepare('SELECT m.* FROM message_media mm JOIN media m ON m.id = mm.media_id WHERE mm.message_id = ? ORDER BY mm.position'),
  pinnedFor: db.prepare('SELECT * FROM messages WHERE chat_id = ? AND pinned = 1 AND deleted_for_all = 0 ORDER BY seq DESC LIMIT 5'),
  hide: db.prepare('INSERT OR IGNORE INTO hidden_messages (message_id, user_id) VALUES (?, ?)'),
  searchInChats: db.prepare(`SELECT m.* , c.type AS chat_type, c.title AS chat_title, c.avatar_url AS chat_avatar
      FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = @uid)
        AND m.deleted_for_all = 0 AND m.text LIKE @q
        AND m.id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = @uid)
      ORDER BY m.created_at DESC LIMIT 40`),
  mediaInChat: db.prepare(`SELECT m.* , md.kind AS m_kind, md.filename, md.mime, md.size, md.width, md.height, md.duration, md.peaks, md.path
      FROM messages m JOIN media md ON md.id = m.media_id
      WHERE m.chat_id = @chat_id AND m.deleted_for_all = 0 AND md.kind IN ('image','video') ORDER BY m.seq DESC LIMIT @limit OFFSET @offset`),
  mediaInChatCount: db.prepare(`SELECT COUNT(*) AS c FROM messages m JOIN media md ON md.id = m.media_id
      WHERE m.chat_id = @chat_id AND m.deleted_for_all = 0 AND md.kind IN ('image','video')`),
  filesInChat: db.prepare(`SELECT m.*, md.kind AS m_kind, md.filename, md.mime, md.size, md.duration, md.peaks, md.path
      FROM messages m JOIN media md ON md.id = m.media_id
      WHERE m.chat_id = @chat_id AND m.deleted_for_all = 0 AND md.kind IN ('file','audio','voice') ORDER BY m.seq DESC LIMIT @limit OFFSET @offset`),
  countAll: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ? AND deleted_for_all = 0'),
  /** Агрегированный счётчик непрочитанных по всем чатам (для бейджа в шапке/заголовке). */
  totalUnread: db.prepare(`SELECT COUNT(*) AS c FROM messages x JOIN chat_members m ON m.chat_id = x.chat_id AND m.user_id = @uid
      WHERE x.seq > m.last_read_seq AND x.sender_id <> @uid AND x.deleted_for_all = 0`),
};

export const scheduledPosts = {
  byId: db.prepare('SELECT * FROM scheduled_posts WHERE id = ?'),
  get: db.prepare('SELECT * FROM scheduled_posts WHERE id = ? AND chat_id = ?'),
  list: db.prepare(`SELECT id, chat_id, sender_id, text, scheduled_at, status, message_id, failure_reason, created_at
    FROM scheduled_posts WHERE chat_id = ? AND status IN ('scheduled','failed') ORDER BY scheduled_at`),
  due: db.prepare(`SELECT id FROM scheduled_posts
    WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20`),
  create: db.prepare(`INSERT INTO scheduled_posts (chat_id, sender_id, text, scheduled_at, created_at, updated_at)
    VALUES (@chat_id, @sender_id, @text, @scheduled_at, @created_at, @updated_at)`),
  publish: db.prepare(`UPDATE scheduled_posts SET status = 'published', message_id = @message_id, failure_reason = NULL, updated_at = @updated_at
    WHERE id = @id AND status = 'scheduled'`),
  cancel: db.prepare(`UPDATE scheduled_posts SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND chat_id = ? AND status = 'scheduled'`),
  fail: db.prepare(`UPDATE scheduled_posts SET status = 'failed', failure_reason = ?, updated_at = ?
    WHERE id = ? AND status = 'scheduled'`),
  redactPublishedForMessage: db.prepare(`UPDATE scheduled_posts SET text = '', updated_at = ?
    WHERE message_id = ? AND status = 'published'`),
};

export const polls = {
  byMessage: db.prepare('SELECT * FROM polls WHERE message_id = ?'),
  votes: db.prepare('SELECT option_id, user_id FROM poll_votes WHERE message_id = ?'),
  create: db.prepare('INSERT INTO polls (message_id, question, options_json, allow_multiple) VALUES (?, ?, ?, ?)'),
  addVote: db.prepare('INSERT OR IGNORE INTO poll_votes (message_id, user_id, option_id, created_at) VALUES (?, ?, ?, ?)'),
  removeVote: db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ? AND option_id = ?'),
  clearUserVotes: db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?'),
  removeForMessage: db.prepare('DELETE FROM polls WHERE message_id = ?'),
};

export const media = {
  create: db.prepare(`INSERT INTO media (owner_id, kind, filename, mime, size, width, height, duration, peaks, path, thumb_path,
    created_at)
    VALUES (@owner_id, @kind, @filename, @mime, @size, @width, @height, @duration, @peaks, @path, @thumb_path,
    @created_at)`),
  byId: db.prepare('SELECT * FROM media WHERE id = ?'),
  byOwner: db.prepare('SELECT * FROM media WHERE owner_id = ? ORDER BY created_at DESC LIMIT 60'),
  deleteIfUnreferenced: db.prepare(`DELETE FROM media WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM message_media WHERE media_id = ?)
    AND NOT EXISTS (SELECT 1 FROM messages WHERE media_id = ?)
    AND NOT EXISTS (SELECT 1 FROM profile_gallery WHERE media_id = ?)
    AND NOT EXISTS (SELECT 1 FROM users WHERE profile_banner_video_media_id = ?)
    AND NOT EXISTS (SELECT 1 FROM gifts WHERE image_media_id = ?)
   AND NOT EXISTS (SELECT 1 FROM stories WHERE media_id = ?)
   RETURNING *`),
};

export const stories = {
 create: db.prepare(`INSERT INTO stories (owner_id, type, text, media_id, created_at, expires_at)
   VALUES (@owner_id, @type, @text, @media_id, @created_at, @expires_at)`),
 byId: db.prepare('SELECT * FROM stories WHERE id = ?'),
 activeByOwner: db.prepare('SELECT * FROM stories WHERE owner_id = ? AND expires_at > ? ORDER BY created_at, id'),
 feed: db.prepare(`SELECT s.id, s.owner_id, s.type, s.text, s.media_id, s.created_at, s.expires_at,
     u.name, u.username, u.avatar_url, u.avatar_color,
     (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id) AS view_count,
     (SELECT COUNT(*) FROM story_likes l WHERE l.story_id = s.id) AS like_count,
     EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = @viewer_id) AS viewed_by_me,
     EXISTS (SELECT 1 FROM story_likes l WHERE l.story_id = s.id AND l.user_id = @viewer_id) AS liked_by_me
   FROM stories s JOIN users u ON u.id = s.owner_id
   WHERE s.expires_at > @now
     AND (s.owner_id = @viewer_id OR EXISTS (
       SELECT 1 FROM chat_members owner_member
       JOIN chat_members viewer_member ON viewer_member.chat_id = owner_member.chat_id
       JOIN chats c ON c.id = owner_member.chat_id
       WHERE owner_member.user_id = s.owner_id AND viewer_member.user_id = @viewer_id
         AND c.type IN ('group','channel')
     ))
     AND NOT EXISTS (SELECT 1 FROM blocks b
       WHERE (b.user_id = s.owner_id AND b.blocked_id = @viewer_id)
          OR (b.user_id = @viewer_id AND b.blocked_id = s.owner_id))
   ORDER BY CASE WHEN s.owner_id = @viewer_id THEN 0 ELSE 1 END, s.owner_id, s.created_at, s.id
   LIMIT 500`),
 ownActiveCount: db.prepare('SELECT COUNT(*) AS count FROM stories WHERE owner_id = ? AND expires_at > ?'),
 insertView: db.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?, ?, ?)'),
 likeExists: db.prepare('SELECT 1 FROM story_likes WHERE story_id = ? AND user_id = ?'),
 addLike: db.prepare('INSERT OR IGNORE INTO story_likes (story_id, user_id, created_at) VALUES (?, ?, ?)'),
 removeLike: db.prepare('DELETE FROM story_likes WHERE story_id = ? AND user_id = ?'),
 deleteOwned: db.prepare('DELETE FROM stories WHERE id = ? AND owner_id = ? RETURNING media_id'),
 expiredMediaIds: db.prepare('SELECT DISTINCT media_id FROM stories WHERE expires_at <= ? AND media_id IS NOT NULL'),
 deleteExpired: db.prepare('DELETE FROM stories WHERE expires_at <= ?'),
};

export const reactions = {
  removeForMessage: db.prepare('DELETE FROM reactions WHERE message_id = ?'),
  all: db.prepare('SELECT r.*, u.name, u.username, u.avatar_url FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? ORDER BY r.created_at'),
  forMessage: db.prepare('SELECT emoji, COUNT(*) AS c FROM reactions WHERE message_id = ? GROUP BY emoji'),
  forMessageUser: db.prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  set: db.prepare(`INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(message_id, user_id, emoji) DO UPDATE SET created_at = excluded.created_at`),
  remove: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  bulkForMessages: db.prepare(`SELECT r.message_id, r.emoji, r.user_id, u.name, u.username
    FROM reactions r JOIN users u ON u.id = r.user_id
    WHERE r.message_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at`),
};

export const comments = {
  byId: db.prepare(`SELECT c.id, c.message_id, c.text, c.created_at, u.id AS author_id, u.name AS author_name,
      u.avatar_url AS author_avatar_url, u.avatar_color AS author_avatar_color,
      c.parent_comment_id, c.edited_at, c.deleted_at,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS likes_count
    FROM message_comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`),
  forMessage: db.prepare(`SELECT c.id, c.message_id, c.text, c.created_at, u.id AS author_id, u.name AS author_name,
      u.avatar_url AS author_avatar_url, u.avatar_color AS author_avatar_color,
      c.parent_comment_id, c.edited_at, c.deleted_at,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS likes_count,
      EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = @userId) AS liked_by_me
    FROM message_comments c JOIN users u ON u.id = c.author_id
    WHERE c.message_id = @messageId ORDER BY c.id ASC`),
  count: db.prepare('SELECT COUNT(*) AS c FROM message_comments WHERE message_id = ? AND deleted_at IS NULL'),
  bulkCount: db.prepare(`SELECT message_id, COUNT(*) AS c FROM message_comments
    WHERE deleted_at IS NULL AND message_id IN (SELECT value FROM json_each(?)) GROUP BY message_id`),
  create: db.prepare('INSERT INTO message_comments (message_id, author_id, text, created_at, parent_comment_id) VALUES (?, ?, ?, ?, ?)'),
  updateText: db.prepare('UPDATE message_comments SET text = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL'),
  softDelete: db.prepare("UPDATE message_comments SET text = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL"),
  parent: db.prepare('SELECT id, message_id, author_id, parent_comment_id, deleted_at FROM message_comments WHERE id = ?'),
  likeExists: db.prepare('SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?'),
  addLike: db.prepare('INSERT OR IGNORE INTO comment_likes (comment_id, user_id, created_at) VALUES (?, ?, ?)'),
  removeLike: db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?'),
  removeAllLikes: db.prepare('DELETE FROM comment_likes WHERE comment_id = ?'),
  likeCount: db.prepare('SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?'),
  likedBy: db.prepare('SELECT 1 AS liked FROM comment_likes WHERE comment_id = ? AND user_id = ?'),
  removeForMessage: db.prepare('DELETE FROM message_comments WHERE message_id = ?'),
};

export const blocks = {
  isBlocked: db.prepare('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?'),
  add: db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)'),
  remove: db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?'),
  list: db.prepare('SELECT blocked_id FROM blocks WHERE user_id = ?'),
};

export const reports = {
  create: db.prepare(`INSERT INTO reports (reporter_id, reported_id, reason, details, created_at)
                      VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(reporter_id, reported_id) DO UPDATE SET reason = excluded.reason, details = excluded.details, created_at = excluded.created_at`),
};

export const events = {
  push: db.prepare('INSERT INTO events (scope, type, payload, created_at) VALUES (?, ?, ?, ?)'),
  since: db.prepare('SELECT * FROM events WHERE scope IN (SELECT value FROM json_each(?)) AND id > ? ORDER BY id ASC LIMIT 300'),
  removeMessageContent: db.prepare(`DELETE FROM events
    WHERE scope = ? AND type IN ('message.new', 'message.edit', 'poll.update')
      AND json_extract(payload, '$.payload.message.id') = ?`),
  prune: db.prepare('DELETE FROM events WHERE id < ?'),
  lastId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events'),
};

export const resets = {
  create: db.prepare('INSERT INTO password_resets (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'),
  byToken: db.prepare('SELECT * FROM password_resets WHERE token = ?'),
  latestForUser: db.prepare('SELECT created_at FROM password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'),
  use: db.prepare('UPDATE password_resets SET used = 1 WHERE token = ? AND used = 0 AND expires_at > ?'),
  invalidateForUser: db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0'),
};

export const passwordResetRequests = {
  byId: db.prepare(`SELECT r.*, u.name, u.username, u.email FROM password_reset_requests r
    JOIN users u ON u.id = r.user_id WHERE r.id = ?`),
  pendingByUser: db.prepare(`SELECT id FROM password_reset_requests
    WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`),
  create: db.prepare(`INSERT INTO password_reset_requests (user_id, status, created_at, updated_at)
    VALUES (?, 'pending', ?, ?)`),
  list: db.prepare(`SELECT r.id, r.user_id, r.status, r.created_at, r.updated_at,
      u.name, u.username, u.email
    FROM password_reset_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status IN ('pending','issued') ORDER BY r.created_at DESC LIMIT 200`),
  setStatus: db.prepare('UPDATE password_reset_requests SET status = ?, updated_at = ? WHERE id = ?'),
  completeForUser: db.prepare(`UPDATE password_reset_requests SET status = 'completed', updated_at = ?
    WHERE user_id = ? AND status IN ('pending','issued')`),
};

export const loginChallenges = {
  create: db.prepare(`INSERT INTO login_challenges (token_hash, user_id, expires_at, created_at)
    VALUES (@token_hash, @user_id, @expires_at, @created_at)`),
  byHash: db.prepare('SELECT * FROM login_challenges WHERE token_hash = ?'),
  remove: db.prepare('DELETE FROM login_challenges WHERE token_hash = ?'),
  removeForUser: db.prepare('DELETE FROM login_challenges WHERE user_id = ?'),
};

export const pushSubscriptions = {
  bySession: db.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE user_id = ? AND session_id = ?'),
  byEndpoint: db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?'),
  forCall: db.prepare(`SELECT ps.endpoint, ps.subscription_json, cm.muted, cp.user_id, s.notify_preview
    FROM push_subscriptions ps
    JOIN call_participants cp ON cp.user_id = ps.user_id AND cp.call_id = ? AND cp.status = 'invited'
    JOIN calls c ON c.id = cp.call_id AND c.status = 'active'
    JOIN chat_members cm ON cm.user_id = cp.user_id AND cm.chat_id = c.chat_id
    JOIN sessions ss ON ss.id = ps.session_id AND ss.revoked_at IS NULL AND ss.expires_at > ?
    LEFT JOIN settings s ON s.user_id = cp.user_id
    WHERE cp.user_id <> ?`),
  upsert: db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, session_id, subscription_json, created_at, updated_at)
    VALUES (@endpoint, @user_id, @session_id, @subscription_json, @created_at, @updated_at)
    ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json,
      user_id = excluded.user_id, session_id = excluded.session_id, updated_at = excluded.updated_at
      WHERE push_subscriptions.user_id = excluded.user_id`),
  remove: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND session_id = ? AND endpoint = ?'),
  removeForSession: db.prepare('DELETE FROM push_subscriptions WHERE session_id = ?'),
  removeSession: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND session_id = ?'),
  removeForUser: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?'),
  removeInvalid: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
  forChat: db.prepare(`SELECT ps.endpoint, ps.subscription_json, ps.session_id, cm.user_id, cm.muted,
      c.type AS chat_type, c.title AS chat_title,
      s.notify_messages, s.notify_groups, s.notify_channels, s.notify_preview
    FROM push_subscriptions ps
    JOIN chat_members cm ON cm.user_id = ps.user_id AND cm.chat_id = ?
    JOIN sessions ss ON ss.id = ps.session_id AND ss.revoked_at IS NULL AND ss.expires_at > ?
    JOIN chats c ON c.id = cm.chat_id
    LEFT JOIN settings s ON s.user_id = cm.user_id
    WHERE cm.user_id <> ?`),
};

export const registrationConsents = {
  create: db.prepare(`INSERT INTO registration_consents
    (user_id, terms_version, privacy_version, personal_data_consent, age_guardian_attested, accepted_at, ip, user_agent)
    VALUES (@user_id, @terms_version, @privacy_version, @personal_data_consent, @age_guardian_attested, @accepted_at, @ip, @user_agent)`),
  byUser: db.prepare('SELECT * FROM registration_consents WHERE user_id = ? ORDER BY accepted_at DESC, id DESC'),
};

export const nativePushTokens = {
  byToken: db.prepare('SELECT user_id FROM native_push_tokens WHERE token = ?'),
  bySession: db.prepare('SELECT token FROM native_push_tokens WHERE user_id = ? AND session_id = ?'),
  upsert: db.prepare(`INSERT INTO native_push_tokens (token, user_id, session_id, created_at, updated_at)
    VALUES (@token, @user_id, @session_id, @created_at, @updated_at)
    ON CONFLICT(token) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
      WHERE native_push_tokens.user_id = excluded.user_id`),
  remove: db.prepare('DELETE FROM native_push_tokens WHERE user_id = ? AND session_id = ? AND token = ?'),
  removeForSession: db.prepare('DELETE FROM native_push_tokens WHERE session_id = ?'),
  removeForUser: db.prepare('DELETE FROM native_push_tokens WHERE user_id = ?'),
  removeInvalid: db.prepare('DELETE FROM native_push_tokens WHERE token = ?'),
  forChat: db.prepare(`SELECT nt.token, nt.user_id, cm.muted,
      c.type AS chat_type, c.title AS chat_title,
      s.notify_messages, s.notify_groups, s.notify_channels, s.notify_preview
    FROM native_push_tokens nt
    JOIN chat_members cm ON cm.user_id = nt.user_id AND cm.chat_id = ?
    JOIN sessions ss ON ss.id = nt.session_id AND ss.revoked_at IS NULL AND ss.expires_at > ?
    JOIN chats c ON c.id = cm.chat_id
    LEFT JOIN settings s ON s.user_id = cm.user_id
    WHERE cm.user_id <> ?`),
  forCall: db.prepare(`SELECT nt.token, nt.user_id, cm.muted, s.notify_preview
    FROM native_push_tokens nt
    JOIN call_participants cp ON cp.user_id = nt.user_id AND cp.call_id = ? AND cp.status = 'invited'
    JOIN calls c ON c.id = cp.call_id AND c.status = 'active'
    JOIN chat_members cm ON cm.user_id = cp.user_id AND cm.chat_id = c.chat_id
    JOIN sessions ss ON ss.id = nt.session_id AND ss.revoked_at IS NULL AND ss.expires_at > ?
    LEFT JOIN settings s ON s.user_id = cp.user_id
    WHERE cp.user_id <> ?`),
};

export const emailVerifications = {
  byUser: db.prepare('SELECT * FROM email_verifications WHERE user_id = ?'),
  upsert: db.prepare(`INSERT INTO email_verifications
    (user_id, code_hash, code_ciphertext, expires_at, attempts, last_sent_at, created_at)
    VALUES (@user_id, @code_hash, @code_ciphertext, @expires_at, 0, @last_sent_at, @created_at)
    ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash,
      code_ciphertext = excluded.code_ciphertext, expires_at = excluded.expires_at,
      attempts = 0, last_sent_at = excluded.last_sent_at, created_at = excluded.created_at`),
  incrementAttempts: db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = ?'),
  remove: db.prepare('DELETE FROM email_verifications WHERE user_id = ?'),
};

/** Транзакция для составных операций (создание чата + участники, отправка сообщения + события). */
export const tx = (fn) => db.transaction(fn);

export const commerce = {
  wallet: db.prepare('SELECT * FROM aurora_wallets WHERE user_id = ?'),
  ensureWallet: db.prepare('INSERT OR IGNORE INTO aurora_wallets (user_id, balance, updated_at) VALUES (?, 0, ?)'),
  updateWallet: db.prepare('UPDATE aurora_wallets SET balance = ?, updated_at = ? WHERE user_id = ?'),
  transaction: db.prepare(`INSERT INTO aurora_transactions
    (user_id, kind, amount, balance_after, reference_type, reference_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  transactions: db.prepare('SELECT * FROM aurora_transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100'),
  premium: db.prepare('SELECT * FROM premium_subscriptions WHERE user_id = ? AND status = \'active\' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1'),
  addPremium: db.prepare('INSERT INTO premium_subscriptions (user_id, plan_id, starts_at, expires_at, status, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  premiumById: db.prepare('SELECT ps.*, u.username, u.name FROM premium_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE ps.id = ?'),
  pendingPremium: db.prepare("SELECT ps.*, u.username, u.name FROM premium_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE ps.status = 'pending' ORDER BY ps.created_at DESC"),
  updatePremium: db.prepare('UPDATE premium_subscriptions SET status = ?, starts_at = ?, expires_at = ? WHERE id = ?'),
  gifts: db.prepare('SELECT * FROM gifts WHERE is_active = 1 AND (stock_remaining IS NULL OR stock_remaining > 0) ORDER BY price'),
  giftPage: db.prepare(`SELECT * FROM gifts WHERE is_active = 1 AND (stock_remaining IS NULL OR stock_remaining > 0)
    ORDER BY created_at DESC, id LIMIT ? OFFSET ?`),
  giftCount: db.prepare('SELECT COUNT(*) AS count FROM gifts WHERE is_active = 1 AND (stock_remaining IS NULL OR stock_remaining > 0)'),
  gift: db.prepare('SELECT * FROM gifts WHERE id = ? AND is_active = 1'),
  giftById: db.prepare('SELECT * FROM gifts WHERE id = ?'),
  giftCreate: db.prepare('INSERT INTO gifts (id, emoji, name, description, price, animation, is_active, rarity, image_media_id, stock_total, stock_remaining, sellback_percent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  giftUpdate: db.prepare('UPDATE gifts SET emoji = ?, name = ?, description = ?, price = ?, animation = ?, rarity = ?, image_media_id = ?, stock_total = ?, stock_remaining = ?, sellback_percent = ?, is_active = ?, updated_at = ? WHERE id = ?'),
  giftDelete: db.prepare('UPDATE gifts SET is_active = 0 WHERE id = ?'),
  giftStock: db.prepare('UPDATE gifts SET stock_remaining = stock_remaining - 1 WHERE id = ? AND is_active = 1 AND (stock_remaining IS NULL OR stock_remaining > 0)'),
  giftIssuedCount: db.prepare('SELECT COUNT(*) AS count FROM received_gifts WHERE gift_id = ?'),
  giftHistoryAdd: db.prepare('INSERT INTO gift_history (user_id, gift_instance_id, gift_id, operation, other_user_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  giftHistory: db.prepare(`SELECT gh.*, g.name AS gift_name, g.emoji, g.rarity, u.username AS other_username, u.name AS other_name
    FROM gift_history gh JOIN gifts g ON g.id = gh.gift_id
    LEFT JOIN users u ON u.id = gh.other_user_id
    WHERE gh.user_id = ? ORDER BY gh.created_at DESC, gh.id DESC LIMIT 100`),
  giftCollection: db.prepare(`SELECT rg.*, g.emoji, g.name, g.description, g.animation, g.rarity, g.image_media_id,
      u.username AS sender_username, u.name AS sender_name
    FROM received_gifts rg JOIN gifts g ON g.id = rg.gift_id JOIN users u ON u.id = rg.sender_id
    WHERE rg.recipient_id = ? AND rg.status = 'owned' AND rg.is_hidden = 0
    ORDER BY rg.pinned_order IS NULL, rg.pinned_order, rg.created_at DESC LIMIT 100`),
  myGiftCollection: db.prepare(`SELECT rg.*, g.emoji, g.name, g.description, g.animation, g.rarity, g.image_media_id,
      u.username AS sender_username, u.name AS sender_name
    FROM received_gifts rg JOIN gifts g ON g.id = rg.gift_id JOIN users u ON u.id = rg.sender_id
    WHERE rg.recipient_id = ? AND rg.status = 'owned'
    ORDER BY rg.pinned_order IS NULL, rg.pinned_order, rg.created_at DESC LIMIT 100`),
  giftOwned: db.prepare("SELECT * FROM received_gifts WHERE id = ? AND recipient_id = ? AND status = 'owned'"),
  giftOwnedCount: db.prepare("SELECT COUNT(*) AS count FROM received_gifts WHERE recipient_id = ? AND status = 'owned'"),
  giftSetHidden: db.prepare("UPDATE received_gifts SET is_hidden = ? WHERE id = ? AND recipient_id = ? AND status = 'owned'"),
  giftSetPinned: db.prepare("UPDATE received_gifts SET pinned_order = ? WHERE id = ? AND recipient_id = ? AND status = 'owned'"),
  giftMarkSold: db.prepare("UPDATE received_gifts SET status = 'sold', pinned_order = NULL WHERE id = ? AND recipient_id = ? AND status = 'owned'"),
  giftHistoryForInstance: db.prepare(`SELECT gh.*, u.username AS other_username, u.name AS other_name
    FROM gift_history gh LEFT JOIN users u ON u.id = gh.other_user_id
    WHERE gh.gift_instance_id = ? AND gh.user_id = ? ORDER BY gh.created_at DESC, gh.id DESC`),
  giftByIdempotency: db.prepare('SELECT * FROM gift_operations WHERE user_id = ? AND idempotency_key = ?'),
  giftOperationAdd: db.prepare('INSERT INTO gift_operations (user_id, idempotency_key, operation, result_json, created_at) VALUES (?, ?, ?, ?, ?)'),
  config: db.prepare('SELECT value FROM commerce_config WHERE key = ?'),
  setConfig: db.prepare('INSERT INTO commerce_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  paymentOrder: {
    byUserKey: db.prepare('SELECT * FROM payment_orders WHERE user_id = ? AND idempotency_key = ?'),
    byId: db.prepare('SELECT * FROM payment_orders WHERE id = ?'),
    byUserId: db.prepare('SELECT * FROM payment_orders WHERE id = ? AND user_id = ?'),
    byProviderId: db.prepare('SELECT * FROM payment_orders WHERE provider_payment_id = ?'),
    create: db.prepare(`INSERT OR IGNORE INTO payment_orders
      (id, user_id, kind, product_id, units, amount_minor, currency, idempotency_key, receipt_email,
        status, created_at, updated_at, provider_mode)
      VALUES (?, ?, ?, ?, ?, ?, 'RUB', ?, ?, 'creating', ?, ?, ?)`),
    attachProvider: db.prepare(`UPDATE payment_orders SET provider_payment_id = ?, confirmation_url = ?,
      provider_status = ?, status = 'pending', updated_at = ?
      WHERE id = ? AND status = 'creating' AND (provider_payment_id IS NULL OR provider_payment_id = ?)`),
    updateProviderStatus: db.prepare(`UPDATE payment_orders SET provider_status = ?, updated_at = ?
      WHERE id = ? AND status IN ('creating', 'pending')`),
    markCanceled: db.prepare(`UPDATE payment_orders SET status = 'canceled', provider_status = ?, updated_at = ?
      WHERE id = ? AND status IN ('creating', 'pending')`),
    markSucceeded: db.prepare(`UPDATE payment_orders SET status = 'succeeded', provider_status = 'succeeded',
      paid_at = ?, updated_at = ? WHERE id = ? AND status IN ('creating', 'pending')`),
  },
  purchases: db.prepare('SELECT * FROM gift_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'),
  received: db.prepare(`SELECT rg.*, g.emoji, g.name, g.description, g.animation, u.username AS sender_username, u.name AS sender_name
    FROM received_gifts rg JOIN gifts g ON g.id = rg.gift_id JOIN users u ON u.id = rg.sender_id
    WHERE rg.recipient_id = ? AND rg.status = 'owned' ORDER BY rg.pinned_order IS NULL, rg.pinned_order, rg.created_at DESC LIMIT 100`),
  addReceived: db.prepare('INSERT INTO received_gifts (gift_id, sender_id, recipient_id, message_id, note, price, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  clearGiftNoteForMessage: db.prepare('UPDATE received_gifts SET note = \'\' WHERE message_id = ?'),
  addPurchase: db.prepare('INSERT INTO gift_purchases (user_id, package_id, auroras, price, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
};
