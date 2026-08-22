//! No-agent stats collector — SSH exec of a single batch command, parse → cache.
//!
//! Sampling cadence: 5s per host, exponential backoff on failure.
//! History: frontend keeps a rolling window; SQLite trend storage lands V1.1.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};

use crate::models::{HostStats, HostStatsHistoryPoint};

/// Single batch command — one round-trip for all metrics.
pub const STATS_BATCH_CMD: &str = r#"awk '{u=$2+$4; t=$2+$4+$5; if (NR==1) {u1=u; t1=t} else {d1=u-u1; d2=t-t1; if (d2>0) printf "cpu=%.1f\n", d1/d2*100}}' /proc/stat && free -m | awk '/Mem:/{printf "mem=%d:%d\n", $2*1024*1024, $3*1024*1024}' && df -P / | awk 'NR==2{printf "disk=%d:%d\n", $2*1024, $3*1024}' && awk '{printf "load=%.2f\n", $1}' /proc/loadavg && awk '{printf "uptime=%d\n", $1}' /proc/uptime"#;

#[derive(Default)]
pub struct StatsCache {
    latest: HashMap<String, HostStats>,
    history: HashMap<String, Vec<HostStatsHistoryPoint>>,
}

#[derive(Clone)]
pub struct StatsCollector {
    cache: Arc<Mutex<StatsCache>>,
    app: AppHandle,
}

impl StatsCollector {
    pub fn new(app: AppHandle) -> Self {
        Self {
            cache: Arc::new(Mutex::new(StatsCache::default())),
            app,
        }
    }

    /// Parse the batch command output into HostStats.
    pub fn parse_batch(&self, host_id: &str, output: &str) -> Option<HostStats> {
        let mut cpu = 0.0_f64;
        let mut mem_total = 0_u64;
        let mut mem_used = 0_u64;
        let mut disk_total = 0_u64;
        let mut disk_used = 0_u64;
        let mut load = 0.0_f64;
        let mut uptime = 0_u64;

        for line in output.lines() {
            if let Some(v) = line.strip_prefix("cpu=") {
                cpu = v.trim().parse().unwrap_or(0.0);
            } else if let Some(v) = line.strip_prefix("mem=") {
                if let Some((t, u)) = v.trim().split_once(':') {
                    mem_total = t.parse().unwrap_or(0);
                    mem_used = u.parse().unwrap_or(0);
                }
            } else if let Some(v) = line.strip_prefix("disk=") {
                if let Some((t, u)) = v.trim().split_once(':') {
                    disk_total = t.parse().unwrap_or(0);
                    disk_used = u.parse().unwrap_or(0);
                }
            } else if let Some(v) = line.strip_prefix("load=") {
                load = v.trim().parse().unwrap_or(0.0);
            } else if let Some(v) = line.strip_prefix("uptime=") {
                uptime = v.trim().parse().unwrap_or(0);
            }
        }

        if mem_total == 0 && disk_total == 0 && uptime == 0 {
            return None;
        }

        let stats = HostStats {
            host_id: host_id.to_string(),
            cpu_percent: cpu,
            mem_used_bytes: mem_used,
            mem_total_bytes: mem_total,
            disk_used_bytes: disk_used,
            disk_total_bytes: disk_total,
            load_avg1: load,
            uptime_seconds: uptime,
            os_release: None,
            kernel: None,
            sampled_at: crate::models::now_iso(),
        };
        Some(stats)
    }

    /// Cache a sample, emit `hosts:stats` event, append history (max 60 pts).
    pub async fn record(&self, stats: HostStats) {
        {
            let mut cache = self.cache.lock().await;
            cache.latest.insert(stats.host_id.clone(), stats.clone());
            let history = cache.history.entry(stats.host_id.clone()).or_default();
            let mem_pct = if stats.mem_total_bytes > 0 {
                stats.mem_used_bytes as f64 / stats.mem_total_bytes as f64 * 100.0
            } else {
                0.0
            };
            history.push(HostStatsHistoryPoint {
                t: stats.sampled_at.clone(),
                cpu: stats.cpu_percent,
                mem_percent: mem_pct,
            });
            if history.len() > 60 {
                history.drain(0..history.len() - 60);
            }
        }
        let _ = self.app.emit("hosts:stats", stats);
    }

    pub async fn latest(&self, host_id: &str) -> Option<HostStats> {
        self.cache.lock().await.latest.get(host_id).cloned()
    }

    pub async fn history(&self, host_id: &str) -> Vec<HostStatsHistoryPoint> {
        self.cache.lock().await.history.get(host_id).cloned().unwrap_or_default()
    }
}
