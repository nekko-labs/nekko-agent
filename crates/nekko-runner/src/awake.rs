use crate::settings::KeepAwake;

/// Whether the supervisor should hold a sleep-prevention assertion right now.
/// A running job always keeps the Mac up under `WhileActive` and `Always`,
/// even if the gates have since started failing: the job must end (or be
/// stopped) before the Mac may sleep, or it would be killed mid-run.
pub fn hold_awake(k: KeepAwake, any_job_running: bool, gates_pass: bool) -> bool {
    match k {
        KeepAwake::SystemDefault => false,
        KeepAwake::WhileActive => any_job_running,
        KeepAwake::Always => gates_pass || any_job_running,
    }
}
