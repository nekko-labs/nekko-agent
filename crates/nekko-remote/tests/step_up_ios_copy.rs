//! The iPhone reads the step-up golden from its own test bundle
//! (`apps/ios/Protocol/Tests/NekkoProtocolTests/Fixtures/step-up.json`,
//! SK-6), as it does `change-proof.json`. This keeps that copy the same file.

#[test]
fn the_step_up_golden_is_the_same_file_the_iphone_reads() {
    let ios =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/ios/Protocol/Tests/NekkoProtocolTests/Fixtures/step-up.json");
    let ios = std::fs::read_to_string(ios).expect("the iPhone copy of the step-up golden");
    assert_eq!(ios, include_str!("golden/step-up.json"), "copy step-up.json to apps/ios as is");
}
