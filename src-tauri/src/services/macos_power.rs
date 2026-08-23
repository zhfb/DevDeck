use crate::services::power::PowerState;

#[cfg(target_os = "macos")]
pub fn set_thread_qos(state: PowerState) {
    let qos = match state {
        PowerState::Active => libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE,
        PowerState::Background => libc::qos_class_t::QOS_CLASS_UTILITY,
        PowerState::Idle => libc::qos_class_t::QOS_CLASS_BACKGROUND,
    };
    unsafe { libc::pthread_set_qos_class_self_np(qos, 0); }
}

#[cfg(not(target_os = "macos"))]
pub fn set_thread_qos(_state: PowerState) {}

#[cfg(target_os = "macos")]
pub struct ActivityLease {
    activity: objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2::runtime::NSObjectProtocol>>,
}

#[cfg(target_os = "macos")]
unsafe impl Send for ActivityLease {}

#[cfg(target_os = "macos")]
impl Drop for ActivityLease {
    fn drop(&mut self) {
        use objc2_foundation::NSProcessInfo;
        unsafe { NSProcessInfo::processInfo().endActivity(&self.activity); }
    }
}

#[cfg(target_os = "macos")]
pub fn begin_activity(reason: &str) -> Option<ActivityLease> {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let reason = NSString::from_str(reason);
    Some(ActivityLease { activity: NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason) })
}

#[cfg(not(target_os = "macos"))]
pub fn begin_activity(_reason: &str) -> Option<()> { None }
