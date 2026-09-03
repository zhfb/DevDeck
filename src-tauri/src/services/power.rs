use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PowerState {
    Active,
    Background,
    Idle,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SamplingPolicy {
    pub stats_interval_secs: Option<u64>,
    pub render_events: bool,
    pub keep_connections: bool,
}

impl SamplingPolicy {
    pub fn for_state(state: PowerState) -> Self {
        match state {
            PowerState::Active => Self {
                stats_interval_secs: Some(5),
                render_events: true,
                keep_connections: true,
            },
            PowerState::Background => Self {
                stats_interval_secs: Some(30),
                render_events: false,
                keep_connections: true,
            },
            PowerState::Idle => Self {
                stats_interval_secs: None,
                render_events: false,
                keep_connections: true,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PowerSnapshot {
    pub state: PowerState,
    pub policy: SamplingPolicy,
}

#[derive(Clone)]
pub struct PowerManager {
    state: Arc<Mutex<PowerState>>,
}

impl PowerManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(PowerState::Active)),
        }
    }

    pub async fn snapshot(&self) -> PowerSnapshot {
        let state = *self.state.lock().await;
        PowerSnapshot {
            state,
            policy: SamplingPolicy::for_state(state),
        }
    }

    pub async fn set_state(&self, state: PowerState) -> PowerSnapshot {
        *self.state.lock().await = state;
        PowerSnapshot {
            state,
            policy: SamplingPolicy::for_state(state),
        }
    }
}

impl Default for PowerManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{PowerState, SamplingPolicy};

    #[test]
    fn active_policy_keeps_fast_refresh() {
        assert_eq!(SamplingPolicy::for_state(PowerState::Active).stats_interval_secs, Some(5));
        assert!(SamplingPolicy::for_state(PowerState::Active).render_events);
    }

    #[test]
    fn background_policy_keeps_connections_but_slows_work() {
        let policy = SamplingPolicy::for_state(PowerState::Background);
        assert_eq!(policy.stats_interval_secs, Some(30));
        assert!(!policy.render_events);
        assert!(policy.keep_connections);
    }

    #[test]
    fn idle_policy_stops_optional_sampling_but_keeps_connections() {
        let policy = SamplingPolicy::for_state(PowerState::Idle);
        assert_eq!(policy.stats_interval_secs, None);
        assert!(!policy.render_events);
        assert!(policy.keep_connections);
    }
}
