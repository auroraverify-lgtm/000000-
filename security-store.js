import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 3;
const SCHEMA = `
CREATE TABLE security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  actor_id INTEGER,
  session_id TEXT,
  ip_address TEXT,
  ip_confidence TEXT NOT NULL CHECK (ip_confidence IN ('tcp_peer', 'unknown_proxy_peer', 'not_available')),
  subject_hash TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  event_key TEXT NOT NULL UNIQUE,
  previous_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX idx_security_events_type_subject ON security_events(event_type, subject_hash, created_at DESC);
CREATE TABLE security_thresholds (
  event_type TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  PRIMARY KEY (event_type, subject_hash, window_start)
);
CREATE INDEX idx_security_thresholds_window ON security_thresholds(window_start);
CREATE TABLE security_service_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE security_reauth_attempts (
  actor_id INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  PRIMARY KEY (actor_id, window_start)
);
CREATE INDEX idx_security_reauth_attempts_window ON security_reauth_attempts(window_start);
CREATE TRIGGER security_events_no_update BEFORE UPDATE ON security_events
BEGIN SELECT RAISE(ABORT, 'security events are append-only'); END;
CREATE TRIGGER security_events_no_delete BEFORE DELETE ON security_events
BEGIN SELECT RAISE(ABORT, 'security events are append-only'); END;

CREATE TABLE security_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  subject_hash TEXT NOT NULL DEFAULT '',
  actor_id INTEGER,
  ip_address TEXT,
  ip_confidence TEXT NOT NULL CHECK (ip_confidence IN ('tcp_peer', 'unknown_proxy_peer', 'not_available')),
  recommendation TEXT NOT NULL
);
CREATE INDEX idx_security_incidents_status ON security_incidents(status, last_seen_at DESC);

CREATE TABLE security_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  reason TEXT NOT NULL
);
INSERT INTO security_state (id, level, updated_at, updated_by, reason) VALUES (1, 0, 0, NULL, 'initialized');

CREATE TABLE security_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'session', 'ip')),
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lifted_at INTEGER,
  lifted_by INTEGER,
  UNIQUE (kind, target, expires_at)
);
CREATE INDEX idx_security_restrictions_active ON security_restrictions(kind, target, expires_at, lifted_at);

CREATE TABLE security_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES security_events(id),
  incident_id INTEGER REFERENCES security_incidents(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX idx_security_notifications_created ON security_notifications(created_at DESC);

CREATE TABLE security_reauth (
  proof_hash TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_security_reauth_expiry ON security_reauth(expires_at, consumed_at);

CREATE TABLE security_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_security_admin_audit_created ON security_admin_audit(created_at DESC);
CREATE TRIGGER security_admin_audit_no_update BEFORE UPDATE ON security_admin_audit
BEGIN SELECT RAISE(ABORT, 'security audit is append-only'); END;
CREATE TRIGGER security_admin_audit_no_delete BEFORE DELETE ON security_admin_audit
BEGIN SELECT RAISE(ABORT, 'security audit is append-only'); END;
`;

let activeStore = null;

function hashEntry(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  return JSON.stringify(value);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
}

export function initializeSecurityStore(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('Security store path is required.');
  ensureParent(filePath);
  const db = new Database(filePath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const version = db.pragma('user_version', { simple: true });
    if (version === SCHEMA_VERSION) return { initialized: false, version };
    if (version === 1) {
      db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS security_thresholds (
          event_type TEXT NOT NULL, subject_hash TEXT NOT NULL, window_start INTEGER NOT NULL,
          event_count INTEGER NOT NULL, PRIMARY KEY (event_type, subject_hash, window_start)
        );
        CREATE INDEX IF NOT EXISTS idx_security_thresholds_window ON security_thresholds(window_start);
        CREATE TABLE IF NOT EXISTS security_service_nonces (
          nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS security_reauth_attempts (
          actor_id INTEGER NOT NULL, window_start INTEGER NOT NULL, attempt_count INTEGER NOT NULL,
          PRIMARY KEY (actor_id, window_start)
        );`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_security_reauth_attempts_window ON security_reauth_attempts(window_start)');
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
      return { initialized: true, version: SCHEMA_VERSION };
    }
    if (version === 2) {
      db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS security_reauth_attempts (
          actor_id INTEGER NOT NULL, window_start INTEGER NOT NULL, attempt_count INTEGER NOT NULL,
          PRIMARY KEY (actor_id, window_start)
        );
        CREATE INDEX IF NOT EXISTS idx_security_reauth_attempts_window ON security_reauth_attempts(window_start);`);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
      return { initialized: true, version: SCHEMA_VERSION };
    }
    if (version !== 0) throw new Error(`Unsupported Security store schema version: ${version}`);
    db.transaction(() => {
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    return { initialized: true, version: SCHEMA_VERSION };
  } finally {
    db.close();
  }
}

export function openSecurityStore(filePath) {
  if (typeof filePath !== 'string' || !filePath || !fs.existsSync(filePath)) {
    throw new Error('Security store is not initialized. Run the explicit security-store initialization command.');
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true });
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`Security store schema version ${version} is not supported; initialize it explicitly.`);
  }
  const store = createStore(db);
  activeStore = store;
  return store;
}

function createStore(db) {
  const lastEvent = db.prepare('SELECT entry_hash FROM security_events ORDER BY id DESC LIMIT 1');
  const lastAudit = db.prepare('SELECT entry_hash FROM security_admin_audit ORDER BY id DESC LIMIT 1');
  const appendEventTx = db.transaction((event) => {
    const previousHash = lastEvent.get()?.entry_hash || '';
    const entry = {
      created_at: event.createdAt,
      event_type: event.type,
      severity: event.severity,
      actor_id: event.actorId,
      session_id: event.sessionId,
      ip_address: event.ipAddress,
      ip_confidence: event.ipConfidence,
      subject_hash: event.subjectHash,
      details_json: canonical(event.details),
      event_key: event.eventKey,
      previous_hash: previousHash,
    };
    const entryHash = hashEntry(canonical(entry));
    const result = db.prepare(`INSERT OR IGNORE INTO security_events
      (created_at, event_type, severity, actor_id, session_id, ip_address, ip_confidence,
        subject_hash, details_json, event_key, previous_hash, entry_hash)
      VALUES (@created_at, @event_type, @severity, @actor_id, @session_id, @ip_address,
        @ip_confidence, @subject_hash, @details_json, @event_key, @previous_hash, @entry_hash)`)
      .run({ ...entry, entry_hash: entryHash });
    const row = db.prepare('SELECT * FROM security_events WHERE event_key = ?').get(event.eventKey);
    return { id: row.id, inserted: result.changes > 0 };
  });
  const appendAuditTx = db.transaction((audit) => {
    const previousHash = lastAudit.get()?.entry_hash || '';
    const entry = {
      created_at: audit.createdAt,
      actor_id: audit.actorId,
      action: audit.action,
      target_type: audit.targetType,
      target_id: audit.targetId,
      reason: audit.reason,
      details_json: canonical(audit.details),
      previous_hash: previousHash,
      idempotency_key: audit.idempotencyKey,
    };
    const entryHash = hashEntry(canonical(entry));
    const result = db.prepare(`INSERT OR IGNORE INTO security_admin_audit
      (created_at, actor_id, action, target_type, target_id, reason, details_json,
       previous_hash, entry_hash, idempotency_key)
      VALUES (@created_at, @actor_id, @action, @target_type, @target_id, @reason,
       @details_json, @previous_hash, @entry_hash, @idempotency_key)`)
      .run({ ...entry, entry_hash: entryHash });
    const row = db.prepare('SELECT id FROM security_admin_audit WHERE idempotency_key = ?')
      .get(audit.idempotencyKey);
    return { id: row.id, inserted: result.changes > 0 };
  });

  return {
    db,
    appendEvent(event) {
      return appendEventTx(event);
    },
    incrementThreshold(type, subjectHash, timestamp, windowMs) {
      db.prepare('DELETE FROM security_thresholds WHERE window_start < ?').run(timestamp - 24 * 60 * 60 * 1000);
      const windowStart = Math.floor(timestamp / windowMs) * windowMs;
      db.prepare(`INSERT INTO security_thresholds (event_type, subject_hash, window_start, event_count)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(event_type, subject_hash, window_start)
        DO UPDATE SET event_count = security_thresholds.event_count + 1`)
        .run(type, subjectHash, windowStart);
      return db.prepare(`SELECT event_count AS count FROM security_thresholds
        WHERE event_type = ? AND subject_hash = ? AND window_start = ?`)
        .get(type, subjectHash, windowStart).count;
    },
    countEvents(type, since) {
      return db.prepare('SELECT COUNT(*) AS count FROM security_events WHERE event_type = ? AND created_at >= ?')
        .get(type, since).count;
    },
    countThresholdEvents(type, since, windowMs) {
      return db.prepare(`SELECT COALESCE(SUM(event_count), 0) AS count FROM security_thresholds
        WHERE event_type = ? AND window_start >= ?`)
        .get(type, since - windowMs).count;
    },
    countOpenCriticalIncidents() {
      return db.prepare(`SELECT COUNT(*) AS count FROM security_incidents
        WHERE severity = 'critical' AND status != 'resolved'`).get().count;
    },
    claimServiceNonce(nonce, expiresAt, timestamp = Date.now()) {
      db.prepare('DELETE FROM security_service_nonces WHERE expires_at <= ?').run(timestamp);
      return db.prepare('INSERT OR IGNORE INTO security_service_nonces (nonce, expires_at) VALUES (?, ?)')
        .run(nonce, expiresAt).changes === 1;
    },
    consumeReauthAttempt(actorId, timestamp, windowMs = 15 * 60 * 1000, maximum = 20) {
      const windowStart = Math.floor(timestamp / windowMs) * windowMs;
      db.prepare('DELETE FROM security_reauth_attempts WHERE window_start < ?').run(timestamp - 24 * 60 * 60 * 1000);
      db.prepare(`INSERT INTO security_reauth_attempts (actor_id, window_start, attempt_count)
        VALUES (?, ?, 1)
        ON CONFLICT(actor_id, window_start)
        DO UPDATE SET attempt_count = security_reauth_attempts.attempt_count + 1`)
        .run(actorId, windowStart);
      const count = db.prepare(`SELECT attempt_count AS count FROM security_reauth_attempts
        WHERE actor_id = ? AND window_start = ?`).get(actorId, windowStart).count;
      return { ok: count <= maximum, remaining: Math.max(0, maximum - count) };
    },
    listEvents({ limit = 100, since = 0 } = {}) {
      return db.prepare(`SELECT id, created_at, event_type, severity, actor_id, session_id,
        ip_address, ip_confidence, subject_hash, details_json, previous_hash, entry_hash
        FROM security_events WHERE created_at >= ? ORDER BY id DESC LIMIT ?`).all(since, limit);
    },
    listIncidents({ limit = 100, status = 'all' } = {}) {
      const where = status === 'all' ? '' : 'WHERE status = ?';
      return db.prepare(`SELECT * FROM security_incidents ${where}
        ORDER BY last_seen_at DESC LIMIT ?`).all(...(status === 'all' ? [limit] : [status, limit]));
    },
    upsertIncident(incident) {
      return db.prepare(`INSERT INTO security_incidents
        (incident_key, event_type, severity, status, first_seen_at, last_seen_at,
         occurrence_count, subject_hash, actor_id, ip_address, ip_confidence, recommendation)
        VALUES (@incidentKey, @type, @severity, 'open', @now, @now, 1, @subjectHash,
          @actorId, @ipAddress, @ipConfidence, @recommendation)
        ON CONFLICT(incident_key) DO UPDATE SET last_seen_at = excluded.last_seen_at,
          occurrence_count = security_incidents.occurrence_count + 1,
          severity = CASE WHEN excluded.severity = 'critical' OR security_incidents.severity = 'critical'
            THEN 'critical' WHEN excluded.severity = 'high' OR security_incidents.severity = 'high'
            THEN 'high' ELSE 'medium' END, status = 'open'`)
        .run(incident).changes;
    },
    acknowledgeIncident(id, status) {
      if (!['acknowledged', 'resolved', 'open'].includes(status)) throw new Error('Invalid incident status.');
      return db.prepare('UPDATE security_incidents SET status = ? WHERE id = ?').run(status, id).changes;
    },
    getState() {
      return db.prepare('SELECT level, updated_at AS updatedAt, updated_by AS updatedBy, reason FROM security_state WHERE id = 1').get();
    },
    setState({ level, updatedAt, updatedBy, reason }) {
      return db.prepare(`UPDATE security_state SET level = ?, updated_at = ?, updated_by = ?, reason = ? WHERE id = 1`)
        .run(level, updatedAt, updatedBy, reason).changes;
    },
    listRestrictions({ activeOnly = false } = {}) {
      return db.prepare(`SELECT id, kind, target, reason, created_by AS createdBy, created_at AS createdAt,
        expires_at AS expiresAt, lifted_at AS liftedAt, lifted_by AS liftedBy
        FROM security_restrictions ${activeOnly ? 'WHERE lifted_at IS NULL AND expires_at > ?' : ''}
        ORDER BY created_at DESC LIMIT 200`)
        .all(...(activeOnly ? [Date.now()] : []));
    },
    addRestriction(restriction) {
      return db.prepare(`INSERT INTO security_restrictions
        (kind, target, reason, created_by, created_at, expires_at)
        VALUES (@kind, @target, @reason, @createdBy, @createdAt, @expiresAt)`)
        .run(restriction).lastInsertRowid;
    },
    liftRestriction(id, actorId, timestamp) {
      return db.prepare(`UPDATE security_restrictions SET lifted_at = ?, lifted_by = ?
        WHERE id = ? AND lifted_at IS NULL`).run(timestamp, actorId, id).changes;
    },
    isRestricted(kind, target, timestamp = Date.now()) {
      return !!db.prepare(`SELECT 1 FROM security_restrictions
        WHERE kind = ? AND target = ? AND lifted_at IS NULL AND expires_at > ? LIMIT 1`)
        .get(kind, target, timestamp);
    },
    addNotification({ eventId = null, incidentId = null, title, body, createdAt = Date.now() }) {
      return db.prepare(`INSERT INTO security_notifications (event_id, incident_id, title, body, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(eventId, incidentId, title, body, createdAt).lastInsertRowid;
    },
    listNotifications(limit = 100) {
      return db.prepare(`SELECT id, event_id AS eventId, incident_id AS incidentId, title, body,
        created_at AS createdAt, read_at AS readAt FROM security_notifications
        ORDER BY id DESC LIMIT ?`).all(limit);
    },
    markNotificationRead(id, timestamp = Date.now()) {
      return db.prepare('UPDATE security_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
        .run(timestamp, id).changes;
    },
    createReauth({ proofHash, actorId, action, createdAt, expiresAt }) {
      db.prepare(`INSERT INTO security_reauth (proof_hash, actor_id, action, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`).run(proofHash, actorId, action, createdAt, expiresAt);
    },
    consumeReauth({ proofHash, actorId, action, timestamp }) {
      const result = db.prepare(`UPDATE security_reauth SET consumed_at = ?
        WHERE proof_hash = ? AND actor_id = ? AND action = ? AND consumed_at IS NULL AND expires_at > ?`)
        .run(timestamp, proofHash, actorId, action, timestamp);
      return result.changes === 1;
    },
    appendAdminAudit(audit) {
      return appendAuditTx(audit);
    },
    verifyChains() {
      let previousEvent = '';
      for (const row of db.prepare('SELECT * FROM security_events ORDER BY id').iterate()) {
        const entry = {
          created_at: row.created_at,
          event_type: row.event_type,
          severity: row.severity,
          actor_id: row.actor_id,
          session_id: row.session_id,
          ip_address: row.ip_address,
          ip_confidence: row.ip_confidence,
          subject_hash: row.subject_hash,
          details_json: row.details_json,
          event_key: row.event_key,
          previous_hash: row.previous_hash,
        };
        if (row.previous_hash !== previousEvent || hashEntry(canonical(entry)) !== row.entry_hash) {
          return { events: false, adminAudit: false };
        }
        previousEvent = row.entry_hash;
      }
      let previousAudit = '';
      for (const row of db.prepare('SELECT * FROM security_admin_audit ORDER BY id').iterate()) {
        const entry = {
          created_at: row.created_at,
          actor_id: row.actor_id,
          action: row.action,
          target_type: row.target_type,
          target_id: row.target_id,
          reason: row.reason,
          details_json: row.details_json,
          previous_hash: row.previous_hash,
          idempotency_key: row.idempotency_key,
        };
        if (row.previous_hash !== previousAudit || hashEntry(canonical(entry)) !== row.entry_hash) {
          return { events: true, adminAudit: false };
        }
        previousAudit = row.entry_hash;
      }
      return { events: true, adminAudit: true };
    },
    transaction(callback) {
      return db.transaction(callback)();
    },
    listAdminAudit(limit = 100) {
      return db.prepare(`SELECT id, created_at AS createdAt, actor_id AS actorId, action,
        target_type AS targetType, target_id AS targetId, reason, details_json AS detailsJson,
        previous_hash AS previousHash, entry_hash AS entryHash
        FROM security_admin_audit ORDER BY id DESC LIMIT ?`).all(limit);
    },
    close() {
      if (activeStore === this) activeStore = null;
      db.close();
    },
  };
}

export function getSecurityStore() {
  if (!activeStore) throw new Error('Security store is not open.');
  return activeStore;
}

export function getActiveSecurityLevel() {
  return activeStore ? activeStore.getState().level : 0;
}
