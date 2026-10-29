use nekko_runner::{KeepAwake, hold_awake};

#[test]
fn keep_awake_options() {
    assert!(!hold_awake(KeepAwake::SystemDefault, true, true));
    assert!(!hold_awake(KeepAwake::SystemDefault, false, false));
    assert!(hold_awake(KeepAwake::WhileActive, true, true) && !hold_awake(KeepAwake::WhileActive, false, true));
    // A running job keeps the Mac up even when the gates now fail.
    assert!(hold_awake(KeepAwake::WhileActive, true, false));
    assert!(hold_awake(KeepAwake::Always, false, true) && !hold_awake(KeepAwake::Always, false, false));
    assert!(hold_awake(KeepAwake::Always, true, false));
}
