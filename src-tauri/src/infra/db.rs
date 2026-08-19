//! SQLite persistence — hosts/groups/tunnels/known_hosts.
//! Credentials NEVER touch the DB: only keychain refs are stored.

use rusqlite::{params, Connection};
use std::path::PathBuf;
use thiserror::Error;

use crate::models::{Host, HostGroup, Tunnel};

#[derive(Error, Debug)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub struct AppDb {
    conn: Connection,
}

impl AppDb {
    /// Open (or create) the database at the app-support dir.
    pub fn open() -> Result<Self, DbError> {
        let dir = Self::data_dir()?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("devdeck.db");
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self { conn };
        db.migrate()?;
        db.seed()?;
        Ok(db)
    }

    fn data_dir() -> Result<PathBuf, DbError> {
        let base = dirs::data_dir()
            .ok_or_else(|| DbError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir")))?;
        Ok(base.join("com.devdeck.app"))
    }

    pub fn path() -> Result<PathBuf, DbError> {
        Ok(Self::data_dir()?.join("devdeck.db"))
    }

    fn migrate(&self) -> Result<(), DbError> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS host_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                env TEXT NOT NULL DEFAULT 'none',
                color TEXT NOT NULL DEFAULT '#7c838d'
            );
            CREATE TABLE IF NOT EXISTS hosts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                address TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22,
                user TEXT NOT NULL DEFAULT 'root',
                group_id TEXT NOT NULL,
                env TEXT NOT NULL DEFAULT 'none',
                credential_ref TEXT,
                fingerprint TEXT,
                last_connected_at TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(group_id) REFERENCES host_groups(id)
            );
            CREATE TABLE IF NOT EXISTS tunnels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                host_id TEXT NOT NULL,
                listen_addr TEXT NOT NULL DEFAULT '127.0.0.1',
                listen_port INTEGER NOT NULL,
                remote_host TEXT NOT NULL DEFAULT 'localhost',
                remote_port INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'stopped'
            );
            CREATE TABLE IF NOT EXISTS known_hosts (
                host_key TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    fn seed(&self) -> Result<(), DbError> {
        let groups: i64 = self.conn.query_row("SELECT COUNT(*) FROM host_groups", [], |r| r.get(0))?;
        if groups == 0 {
            let now = crate::models::now_iso();
            self.conn.execute_batch(
                r#"
                INSERT INTO host_groups (id, name, env, color) VALUES
                    ('g-dev', 'Dev', 'dev', '#30D158'),
                    ('g-staging', 'Staging', 'staging', '#FFD60A'),
                    ('g-prod', 'Prod', 'prod', '#FF453A');
                "#,
            )?;
            self.conn.execute(
                "INSERT INTO hosts (id, name, address, port, user, group_id, env, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    "h-ali-hk",
                    "香港 VPS",
                    "160.202.46.104",
                    22,
                    "root",
                    "g-prod",
                    "prod",
                    now
                ],
            )?;
        }
        Ok(())
    }

    // ---- groups ----
    pub fn list_groups(&self) -> Result<Vec<HostGroup>, DbError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, env, color FROM host_groups ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| {
            Ok(HostGroup {
                id: r.get(0)?,
                name: r.get(1)?,
                env: r.get(2)?,
                color: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    // ---- hosts ----
    pub fn list_hosts(&self) -> Result<Vec<Host>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, address, port, user, group_id, env, credential_ref, fingerprint, last_connected_at, created_at FROM hosts ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Host {
                id: r.get(0)?,
                name: r.get(1)?,
                address: r.get(2)?,
                port: r.get(3)?,
                user: r.get(4)?,
                group_id: r.get(5)?,
                env: r.get(6)?,
                credential_ref: r.get(7)?,
                fingerprint: r.get(8)?,
                last_connected_at: r.get(9)?,
                created_at: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_host(&self, id: &str) -> Result<Option<Host>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, address, port, user, group_id, env, credential_ref, fingerprint, last_connected_at, created_at FROM hosts WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([id], |r| {
            Ok(Host {
                id: r.get(0)?,
                name: r.get(1)?,
                address: r.get(2)?,
                port: r.get(3)?,
                user: r.get(4)?,
                group_id: r.get(5)?,
                env: r.get(6)?,
                credential_ref: r.get(7)?,
                fingerprint: r.get(8)?,
                last_connected_at: r.get(9)?,
                created_at: r.get(10)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn upsert_host(&self, h: &Host) -> Result<(), DbError> {
        self.conn.execute(
            "INSERT INTO hosts (id, name, address, port, user, group_id, env, credential_ref, fingerprint, last_connected_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, address=excluded.address, port=excluded.port,
               user=excluded.user, group_id=excluded.group_id, env=excluded.env,
               credential_ref=excluded.credential_ref, fingerprint=excluded.fingerprint",
            params![
                h.id, h.name, h.address, h.port, h.user, h.group_id, h.env,
                h.credential_ref, h.fingerprint, h.last_connected_at, h.created_at
            ],
        )?;
        Ok(())
    }

    pub fn delete_host(&self, id: &str) -> Result<(), DbError> {
        self.conn.execute("DELETE FROM hosts WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn touch_host(&self, id: &str, at: &str) -> Result<(), DbError> {
        self.conn.execute("UPDATE hosts SET last_connected_at = ?1 WHERE id = ?2", params![at, id])?;
        Ok(())
    }

    // ---- tunnels ----
    pub fn list_tunnels(&self) -> Result<Vec<Tunnel>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, type, host_id, listen_addr, listen_port, remote_host, remote_port, status FROM tunnels ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Tunnel {
                id: r.get(0)?,
                name: r.get(1)?,
                type_: r.get(2)?,
                host_id: r.get(3)?,
                listen_addr: r.get(4)?,
                listen_port: r.get(5)?,
                remote_host: r.get(6)?,
                remote_port: r.get(7)?,
                status: r.get(8)?,
                bytes_in: None,
                bytes_out: None,
                started_at: None,
                error: None,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn upsert_tunnel(&self, t: &Tunnel) -> Result<(), DbError> {
        self.conn.execute(
            "INSERT INTO tunnels (id, name, type, host_id, listen_addr, listen_port, remote_host, remote_port, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, type=excluded.type, host_id=excluded.host_id,
               listen_addr=excluded.listen_addr, listen_port=excluded.listen_port,
               remote_host=excluded.remote_host, remote_port=excluded.remote_port, status=excluded.status",
            params![
                t.id, t.name, t.type_, t.host_id, t.listen_addr, t.listen_port,
                t.remote_host, t.remote_port, t.status
            ],
        )?;
        Ok(())
    }

    pub fn delete_tunnel(&self, id: &str) -> Result<(), DbError> {
        self.conn.execute("DELETE FROM tunnels WHERE id = ?1", [id])?;
        Ok(())
    }
}
