import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const execAsync = promisify(exec);

// Backups live OUTSIDE public/ (never web-served) — downloads go through the
// authenticated API only.
const BACKUP_DIR = path.join(__dirname, '../../backups');
const DATA_DIR = path.join(__dirname, '../../data');

export interface BackupItem {
  name: string;
  size: number;
  createdAt: Date;
  kind: 'db' | 'sessions' | 'other';
}

function ensureDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Build libpq env from DATABASE_URL so credentials never appear in process args.
function pgEnv(): NodeJS.ProcessEnv {
  const u = new URL(process.env.DATABASE_URL || '');
  return {
    ...process.env,
    PGHOST: u.hostname || 'localhost',
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username || ''),
    PGPASSWORD: decodeURIComponent(u.password || ''),
    PGDATABASE: (u.pathname || '').replace(/^\//, ''),
  };
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Create a full backup: gzipped pg_dump of the database, plus a tarball of the
 * WhatsApp session folder (so reconnected sessions survive a restore).
 */
export async function createBackup(): Promise<{ db: string; sessions?: string }> {
  ensureDir();
  const s = stamp();

  // 1) Database (the critical data: shops, products, orders, prospects, settings)
  const dbFile = path.join(BACKUP_DIR, `wardat-db-${s}.sql.gz`);
  await execAsync(`pg_dump --no-owner --no-privileges | gzip > "${dbFile}"`, {
    env: pgEnv(),
    maxBuffer: 1024 * 1024 * 256,
  });

  // 2) WhatsApp sessions (Baileys auth creds) — optional
  let sessionsName: string | undefined;
  const sessionsPath = path.join(DATA_DIR, 'whatsapp-sessions');
  if (fs.existsSync(sessionsPath)) {
    const sessionsFile = path.join(BACKUP_DIR, `wardat-sessions-${s}.tar.gz`);
    try {
      await execAsync(`tar czf "${sessionsFile}" -C "${DATA_DIR}" whatsapp-sessions`);
      sessionsName = path.basename(sessionsFile);
    } catch (e: any) {
      logger.warn(`[Backup] Sessions archive failed: ${e.message}`);
    }
  }

  logger.info(`[Backup] Created ${path.basename(dbFile)}${sessionsName ? ' + ' + sessionsName : ''}`);
  return { db: path.basename(dbFile), sessions: sessionsName };
}

export function listBackups(): BackupItem[] {
  ensureDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.gz'))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      const kind: BackupItem['kind'] = f.startsWith('wardat-db-')
        ? 'db'
        : f.startsWith('wardat-sessions-')
        ? 'sessions'
        : 'other';
      return { name: f, size: st.size, createdAt: st.mtime, kind };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// Resolve a user-supplied filename to a path INSIDE the backup dir, or null.
export function safeBackupPath(name: string): string | null {
  if (!/^[\w.\-]+\.(sql|tar)\.gz$/.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  if (path.dirname(p) !== BACKUP_DIR) return null;
  if (!fs.existsSync(p)) return null;
  return p;
}

/**
 * Restore the database from a `wardat-db-*.sql.gz` backup.
 *
 * DESTRUCTIVE: this overwrites ALL current data. Safeguards:
 *  - validates the filename (no path traversal, DB backups only),
 *  - takes a fresh SAFETY snapshot of the current state first (so a mistaken
 *    restore is reversible — its name is returned to the caller),
 *  - drops only the app-owned tables in the `public` schema, then loads the dump,
 *  - strips the version-specific `transaction_timeout` SET that an older server
 *    rejects, and verifies tables exist afterwards.
 */
export async function restoreBackup(name: string): Promise<{ safetyBackup: string; tables: number }> {
  const p = safeBackupPath(name);
  if (!p || !name.startsWith('wardat-db-') || !name.endsWith('.sql.gz')) {
    throw new Error('ملف غير صالح: الاستعادة متاحة لنسخ قاعدة البيانات فقط.');
  }

  // 1) Safety snapshot of the CURRENT state before we overwrite it.
  const safety = await createBackup();
  logger.warn(`[Backup] RESTORE starting from ${name}. Safety snapshot taken: ${safety.db}`);

  // 2) Drop existing app tables (owned by the connecting user). Written to a temp
  //    file and run with -f so no SQL/`$$` ever touches the shell.
  const dropSql =
    'DO $$ DECLARE r RECORD; BEGIN ' +
    "FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP " +
    "EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE'; " +
    'END LOOP; END $$;';
  const tmpSql = path.join(BACKUP_DIR, `.restore-drop-${Date.now()}.sql`);
  fs.writeFileSync(tmpSql, dropSql);
  try {
    await execAsync(`psql -v ON_ERROR_STOP=1 -f "${tmpSql}"`, { env: pgEnv() });

    // 3) Load the dump. We strip the version-specific `transaction_timeout` SET
    //    (an older server rejects it) and run fail-fast: any OTHER error aborts so
    //    we never report success on a partial restore — the safety snapshot stays
    //    available for rollback.
    await execAsync(
      `set -o pipefail; gunzip -c "${p}" | sed '/transaction_timeout/d' | psql -v ON_ERROR_STOP=1`,
      { env: pgEnv(), maxBuffer: 1024 * 1024 * 256, shell: '/bin/bash' }
    );
  } finally {
    try { fs.unlinkSync(tmpSql); } catch { /* ignore */ }
  }

  // 4) Verify the restore actually produced tables; otherwise the DB is now empty
  //    and the operator must roll back from the safety snapshot.
  const { stdout } = await execAsync(
    `psql -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"`,
    { env: pgEnv() }
  );
  const tables = parseInt((stdout || '').trim(), 10) || 0;
  if (tables < 1) {
    throw new Error(`فشلت الاستعادة (لم تُنشأ أي جداول). استعد الحالة السابقة من نسخة الأمان: ${safety.db}`);
  }

  logger.warn(`[Backup] RESTORE completed from ${name}. ${tables} tables restored. Safety snapshot: ${safety.db}`);
  return { safetyBackup: safety.db, tables };
}

export function deleteBackup(name: string): boolean {
  const p = safeBackupPath(name);
  if (!p) return false;
  fs.unlinkSync(p);
  logger.info(`[Backup] Deleted ${name}`);
  return true;
}

/** Delete backups older than `days` days. */
export async function applyRetention(days: number): Promise<number> {
  ensureDir();
  const cutoff = Date.now() - days * 86400000;
  let pruned = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.endsWith('.gz')) continue;
    const p = path.join(BACKUP_DIR, f);
    try {
      if (fs.statSync(p).mtime.getTime() < cutoff) {
        fs.unlinkSync(p);
        pruned++;
        logger.info(`[Backup] Pruned old backup ${f}`);
      }
    } catch {
      /* ignore */
    }
  }
  return pruned;
}
