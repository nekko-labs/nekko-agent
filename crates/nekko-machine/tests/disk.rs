//! `probe::disk_space`: the volume's total and free bytes.

#[test]
fn disk_space_reads_total_and_free() {
    let dir = std::env::temp_dir();
    let (total, free) = nekko_machine::probe::disk_space(&dir).expect("a readable volume");
    assert!(total > 0.0 && free > 0.0 && free <= total, "total {total}, free {free}");
    assert_eq!(nekko_machine::probe::disk_free(&dir), Some(free));
}

#[test]
fn disk_space_of_a_missing_path_is_none() {
    assert_eq!(nekko_machine::probe::disk_space(std::path::Path::new("/no/such/nekko/path")), None);
}
