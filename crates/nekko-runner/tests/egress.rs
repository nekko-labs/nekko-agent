use nekko_runner::{HostNets, guest_may_connect, guest_may_reach};

fn check(list: &[&str], want: bool) {
    for s in list {
        assert_eq!(guest_may_reach(s.parse().unwrap()), want, "{s}");
    }
}

#[test]
fn brief_lists() {
    check(&["1.1.1.1", "140.82.112.3", "2606:4700::1111"], true);
    check(
        &[
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "100.100.100.100",
            "224.0.0.251",
            "255.255.255.255",
            "0.1.2.3",
            "240.0.0.1",
            "198.18.0.1",
            "::1",
            "fe80::1",
            "fd7a:115c:a1e0::1",
            "::ffff:192.168.1.1",
        ],
        false,
    );
}

#[test]
fn v4_boundaries() {
    check(
        &[
            "0.0.0.0",
            "0.255.255.255",
            "10.0.0.0",
            "10.255.255.255",
            "100.64.0.0",
            "100.127.255.255",
            "127.0.0.0",
            "127.255.255.255",
            "169.254.0.0",
            "169.254.255.255",
            "172.16.0.0",
            "172.31.255.255",
            "192.0.0.0",
            "192.0.0.255",
            "192.0.2.0",
            "192.0.2.255",
            "192.88.99.0",
            "192.88.99.255",
            "192.168.0.0",
            "192.168.255.255",
            "198.18.0.0",
            "198.19.255.255",
            "198.51.100.0",
            "198.51.100.255",
            "203.0.113.0",
            "203.0.113.255",
            "224.0.0.0",
            "239.255.255.255",
            "240.0.0.0",
            "255.255.255.254",
        ],
        false,
    );
    check(
        &[
            "1.0.0.0",
            "9.255.255.255",
            "11.0.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "126.255.255.255",
            "128.0.0.0",
            "169.253.255.255",
            "169.255.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.0.1.0",
            "192.0.3.0",
            "192.88.98.255",
            "192.88.100.0",
            "192.167.255.255",
            "192.169.0.0",
            "198.17.255.255",
            "198.20.0.0",
            "198.51.99.255",
            "198.51.101.0",
            "203.0.112.255",
            "203.0.114.0",
            "223.255.255.255",
        ],
        true,
    );
}

#[test]
fn v6_special_ranges() {
    check(
        &[
            "::",
            "::1",
            "100::",
            "100::ffff:ffff:ffff:ffff",
            "2001::",
            "2001:1ff:ffff::1",
            "2001::1",
            "2001:db8::",
            "2001:db8:ffff::1",
            "fc00::",
            "fdff:ffff::1",
            "fe80::",
            "febf::1",
            "fec0::",
            "feff::1",
            "ff00::",
            "ff02::fb",
            "4000::1",
            "8000::1",
            "1::1",
        ],
        false,
    );
    check(
        &[
            "2001:200::",
            "2001:4860:4860::8888",
            "2001:db7::1",
            "2001:db9::1",
            "2600::1",
            "3fff:ffff::",
            "2606:4700::1111",
            "3ffe::1",
        ],
        true,
    );
}

#[test]
fn embedded_v4_is_judged_as_v4() {
    check(&["::ffff:192.168.1.1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:100.64.0.1"], false);
    check(&["::ffff:1.1.1.1", "::ffff:140.82.112.3"], true);
    // NAT64 64:ff9b::/96
    check(&["64:ff9b::a00:1", "64:ff9b::c0a8:101", "64:ff9b::7f00:1"], false);
    check(&["64:ff9b::101:101"], true);
    // 6to4 2002::/16
    check(&["2002:c0a8:0101::", "2002:0a00:0001::", "2002:7f00:1::", "2002::"], false);
    check(&["2002:0101:0101::", "2002:8c52:7003::1"], true);
}

#[test]
fn more_v4_and_v6_probes() {
    // 3fff::/20 is the documentation range: not routed, so it reaches nothing local and stays allowed.
    check(&["191.255.255.255", "2000::", "3fff::"], true);
}

fn host() -> HostNets {
    HostNets::new(vec!["81.2.69.160".parse().unwrap()], vec![("2a02:1234:5678:1::".parse().unwrap(), 64)])
}

fn connect(ip: &str, host: &HostNets) -> bool {
    guest_may_connect(ip.parse().unwrap(), host)
}

#[test]
fn host_v6_prefix_is_denied() {
    assert!(!connect("2a02:1234:5678:1::42", &host()));
    assert!(connect("2a02:1234:5678:2::1", &host()));
}

#[test]
fn host_public_v4_is_denied() {
    assert!(!connect("81.2.69.160", &host()));
    assert!(connect("81.2.69.161", &host()));
    assert!(!connect("::ffff:81.2.69.160", &host()));
}

#[test]
fn on_link_public_v4_prefix_is_denied() {
    let h = HostNets::new(vec![], vec![("81.2.69.0".parse().unwrap(), 24)]);
    assert!(!connect("81.2.69.7", &h));
    assert!(connect("81.2.70.7", &h));
    // A v4 prefix never matches a v6 address.
    assert!(connect("2a02:1234:5678:1::42", &h));
}

#[test]
fn oversized_prefix_lengths_are_clamped() {
    let h = HostNets::new(vec![], vec![("81.2.69.7".parse().unwrap(), 200), ("2a02::1".parse().unwrap(), 255)]);
    assert!(!connect("81.2.69.7", &h));
    assert!(connect("81.2.69.8", &h));
    assert!(!connect("2a02::1", &h));
    assert!(connect("2a02::2", &h));
}

#[test]
fn empty_host_nets_equals_the_static_check() {
    let h = HostNets::new(vec![], vec![]);
    for s in ["1.1.1.1", "10.0.0.1", "2606:4700::1111", "fe80::1", "::ffff:192.168.1.1", "81.2.69.160"] {
        let ip = s.parse().unwrap();
        assert_eq!(guest_may_connect(ip, &h), guest_may_reach(ip), "{s}");
    }
}
