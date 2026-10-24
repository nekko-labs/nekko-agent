//! The runner NAT (`src/runner/net.rs`) against a fake guest: a second
//! smoltcp interface on the other end of the socketpair, driven by the test.
//! The egress policy runs for real through `HostNets`; only host sockets are
//! redirected, by `TestConnector`, from public-looking addresses to local
//! servers. Refusal tests map the refused address to a live local server too,
//! so a policy hole would show up as a connection, not a timeout.

#[path = "../src/runner/net.rs"]
#[allow(dead_code)]
mod net;

use nekko_runner::HostNets;
use net::{Connector, GATEWAY, GUEST, NetConfig, serve_with};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, Device, DeviceCapabilities, Medium};
use smoltcp::socket::{dhcpv4, tcp, udp};
use smoltcp::time::Instant;
use smoltcp::wire::{
    EthernetAddress, EthernetFrame, EthernetProtocol, EthernetRepr, HardwareAddress, IpAddress, IpCidr, IpEndpoint,
    IpProtocol, Ipv4Address, Ipv4Packet, Ipv4Repr, TcpControl, TcpPacket, TcpRepr, TcpSeqNumber,
};
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::unix::net::UnixDatagram as StdDgram;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket, UnixDatagram};
use tokio::task::JoinHandle;

const GUEST_MAC: EthernetAddress = EthernetAddress([0x02, 0, 0, 0, 0, 0x02]);
const PUBLIC: Ipv4Addr = Ipv4Addr::new(93, 184, 216, 34);

#[derive(Clone, Default)]
struct TestConnector {
    map: Arc<HashMap<SocketAddr, SocketAddr>>,
    calls: Arc<Mutex<Vec<(&'static str, SocketAddr)>>>,
}

impl TestConnector {
    fn new(map: impl IntoIterator<Item = (SocketAddr, SocketAddr)>) -> Self {
        Self { map: Arc::new(map.into_iter().collect()), calls: Arc::default() }
    }
    fn calls(&self) -> Vec<(&'static str, SocketAddr)> {
        self.calls.lock().unwrap().clone()
    }
    fn target(&self, kind: &'static str, dst: SocketAddr) -> io::Result<SocketAddr> {
        self.calls.lock().unwrap().push((kind, dst));
        self.map.get(&dst).copied().ok_or_else(|| io::Error::other("unmapped"))
    }
}

impl Connector for TestConnector {
    async fn tcp(&self, dst: SocketAddr) -> io::Result<TcpStream> {
        TcpStream::connect(self.target("tcp", dst)?).await
    }
    async fn udp(&self, dst: SocketAddr) -> io::Result<UdpSocket> {
        let to = self.target("udp", dst)?;
        let s = UdpSocket::bind("127.0.0.1:0").await?;
        s.connect(to).await?;
        Ok(s)
    }
}

fn sa(ip: Ipv4Addr, port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(ip), port)
}

fn ep(ip: Ipv4Addr, port: u16) -> IpEndpoint {
    IpEndpoint::new(IpAddress::Ipv4(ip), port)
}

/// A TCP server answering each read with `pong:` and the bytes, closing on EOF.
async fn pong_server() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(&[b"pong:", &buf[..n]].concat()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    addr
}

const BULK: usize = 1024 * 1024;

/// A TCP server that counts what it reads until EOF, then writes the count
/// (8 bytes, big endian) and `BULK` bytes, and closes.
async fn bulk_server() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let (mut n, mut buf) = (0u64, vec![0u8; 64 * 1024]);
                while let Ok(k) = s.read(&mut buf).await {
                    if k == 0 {
                        break;
                    }
                    n += k as u64;
                }
                let _ = s.write_all(&n.to_be_bytes()).await;
                let _ = s.write_all(&vec![9u8; BULK]).await;
            });
        }
    });
    addr
}

/// A UDP server echoing `echo:` and the datagram.
async fn udp_echo() -> SocketAddr {
    let s = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = s.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 2048];
        while let Ok((n, from)) = s.recv_from(&mut buf).await {
            let _ = s.send_to(&[b"echo:", &buf[..n]].concat(), from).await;
        }
    });
    addr
}

/// A DNS upstream answering `ans:` + query + `tail`.
async fn fake_dns(tail: &'static [u8]) -> SocketAddr {
    let s = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = s.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        while let Ok((n, from)) = s.recv_from(&mut buf).await {
            let _ = s.send_to(&[b"ans:", &buf[..n], tail].concat(), from).await;
        }
    });
    addr
}

struct GuestDev {
    sock: StdDgram,
    buf: Vec<u8>,
}
struct GRx<'a>(&'a [u8]);
struct GTx<'a>(&'a StdDgram);

impl phy::RxToken for GRx<'_> {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(self.0)
    }
}
impl phy::TxToken for GTx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut b = vec![0u8; len];
        let r = f(&mut b);
        let _ = self.0.send(&b);
        r
    }
}
impl Device for GuestDev {
    type RxToken<'a> = GRx<'a>;
    type TxToken<'a> = GTx<'a>;
    fn receive(&mut self, _: Instant) -> Option<(GRx<'_>, GTx<'_>)> {
        let n = self.sock.recv(&mut self.buf).ok()?;
        Some((GRx(&self.buf[..n]), GTx(&self.sock)))
    }
    fn transmit(&mut self, _: Instant) -> Option<GTx<'_>> {
        Some(GTx(&self.sock))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ethernet;
        c.max_transmission_unit = 1514;
        c
    }
}

struct Guest {
    iface: Interface,
    dev: GuestDev,
    sockets: SocketSet<'static>,
}

impl Guest {
    fn new(sock: UnixDatagram, static_ip: bool) -> Self {
        let sock = sock.into_std().unwrap();
        sock.set_nonblocking(true).unwrap();
        // As the real helper's end is sized.
        net::widen_buffers(&sock).unwrap();
        let mut dev = GuestDev { sock, buf: vec![0; 65536] };
        let mut iface = Interface::new(Config::new(HardwareAddress::Ethernet(GUEST_MAC)), &mut dev, Instant::now());
        if static_ip {
            iface.update_ip_addrs(|a| a.push(IpCidr::new(IpAddress::Ipv4(GUEST), 24)).unwrap());
            iface.routes_mut().add_default_ipv4_route(GATEWAY).unwrap();
        }
        Self { iface, dev, sockets: SocketSet::new(vec![]) }
    }

    /// Drives the guest until `done` or `secs` pass.
    async fn run_until(&mut self, secs: u64, mut done: impl FnMut(&mut Guest) -> bool) -> bool {
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            self.iface.poll(Instant::now(), &mut self.dev, &mut self.sockets);
            if done(self) {
                return true;
            }
            if std::time::Instant::now() > end {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    fn connect(&mut self, ip: Ipv4Addr, port: u16, local_port: u16) -> SocketHandle {
        let mut s = tcp::Socket::new(tcp::SocketBuffer::new(vec![0; 65536]), tcp::SocketBuffer::new(vec![0; 65536]));
        s.connect(self.iface.context(), ep(ip, port), local_port).unwrap();
        self.sockets.add(s)
    }

    fn tcp(&mut self, h: SocketHandle) -> &mut tcp::Socket<'static> {
        self.sockets.get_mut::<tcp::Socket>(h)
    }

    fn udp(&mut self, port: u16) -> SocketHandle {
        let buf = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 16], vec![0; 8192]);
        let mut s = udp::Socket::new(buf(), buf());
        s.bind(port).unwrap();
        self.sockets.add(s)
    }

    fn udp_sock(&mut self, h: SocketHandle) -> &mut udp::Socket<'static> {
        self.sockets.get_mut::<udp::Socket>(h)
    }

    /// Runs until `h` has a datagram, returning it and its source.
    async fn udp_recv(&mut self, h: SocketHandle, secs: u64) -> Option<(Vec<u8>, IpEndpoint)> {
        let mut got = None;
        self.run_until(secs, |g| {
            if let Ok((d, meta)) = g.udp_sock(h).recv() {
                got = Some((d.to_vec(), meta.endpoint));
            }
            got.is_some()
        })
        .await;
        got
    }

    /// Runs until `h` is reset or closed; true if it ended without ever connecting.
    async fn refused(&mut self, h: SocketHandle) -> bool {
        let mut established = false;
        let closed = self
            .run_until(5, |g| {
                established |= g.tcp(h).may_send();
                g.tcp(h).state() == tcp::State::Closed
            })
            .await;
        closed && !established
    }

    /// Sends `msg` on `h` and reads until `want` bytes arrive.
    async fn round_trip(&mut self, h: SocketHandle, msg: &[u8], want: usize) -> Vec<u8> {
        assert!(self.run_until(5, |g| g.tcp(h).may_send()).await, "never connected");
        self.tcp(h).send_slice(msg).unwrap();
        let mut got = vec![];
        self.run_until(5, |g| {
            while g.tcp(h).can_recv() {
                let _ = g.tcp(h).recv(|b| {
                    got.extend_from_slice(b);
                    (b.len(), ())
                });
            }
            got.len() >= want
        })
        .await;
        got
    }
}

struct Run {
    guest: Guest,
    conn: TestConnector,
    nat: JoinHandle<io::Result<()>>,
}

fn start(host: HostNets, max_flows: usize, dns: Vec<SocketAddr>, conn: TestConnector, static_ip: bool) -> Run {
    let (g, n) = UnixDatagram::pair().unwrap();
    let cfg = NetConfig { max_flows, dns_upstream: dns };
    let nat = tokio::spawn(serve_with(n, Arc::new(RwLock::new(host)), cfg, conn.clone()));
    Run { guest: Guest::new(g, static_ip), conn, nat }
}

#[tokio::test(flavor = "multi_thread")]
async fn dhcp_offers_the_guest_address_and_gateway() {
    let mut r = start(HostNets::default(), 16, vec![], TestConnector::default(), false);
    let h = r.guest.sockets.add(dhcpv4::Socket::new());
    let mut got = None;
    r.guest
        .run_until(10, |g| {
            if let Some(dhcpv4::Event::Configured(c)) = g.sockets.get_mut::<dhcpv4::Socket>(h).poll() {
                got = Some((c.address, c.router, c.dns_servers.iter().copied().collect::<Vec<Ipv4Address>>()));
            }
            got.is_some()
        })
        .await;
    let (address, router, dns) = got.expect("no DHCP lease");
    assert_eq!(address.to_string(), "10.233.0.2/24");
    assert_eq!(router, Some(GATEWAY));
    assert_eq!(dns, vec![GATEWAY]);
}

#[tokio::test(flavor = "multi_thread")]
async fn dns_query_is_forwarded_and_answered() {
    let up = fake_dns(b"").await;
    let mut r = start(HostNets::default(), 16, vec![up], TestConnector::default(), true);
    let h = r.guest.udp(5353);
    r.guest.udp_sock(h).send_slice(b"query1", ep(GATEWAY, 53)).unwrap();
    let (data, from) = r.guest.udp_recv(h, 5).await.expect("no DNS answer");
    assert_eq!(data, b"ans:query1");
    assert_eq!(from, ep(GATEWAY, 53));
    assert!(r.conn.calls().is_empty(), "DNS goes to the upstream, not the connector");
}

#[tokio::test(flavor = "multi_thread")]
async fn tcp_to_public_address_is_forwarded() {
    let server = pong_server().await;
    let bulk = bulk_server().await;
    let conn = TestConnector::new([(sa(PUBLIC, 443), server), (sa(PUBLIC, 444), bulk)]);
    let mut r = start(HostNets::default(), 16, vec![], conn, true);
    let h = r.guest.connect(PUBLIC, 443, 40000);
    let got = r.guest.round_trip(h, b"hello", 10).await;
    assert_eq!(got, b"pong:hello");
    // Guest FIN reaches the server, whose FIN comes back.
    r.guest.tcp(h).close();
    let s = r.guest.run_until(5, |g| matches!(g.tcp(h).state(), tcp::State::TimeWait | tcp::State::Closed)).await;
    assert!(s, "close did not complete: {:?}", r.guest.tcp(h).state());

    // Bulk both ways, far larger than every buffer on the path: 1 MiB up
    // (then FIN), the server's count and 1 MiB down (then FIN).
    let h = r.guest.connect(PUBLIC, 444, 40010);
    assert!(r.guest.run_until(5, |g| g.tcp(h).may_send()).await);
    let (mut sent, mut got) = (0usize, vec![]);
    let done = r
        .guest
        .run_until(30, |g| {
            let s = g.tcp(h);
            if sent < BULK {
                sent += s.send_slice(&vec![7u8; (BULK - sent).min(16 * 1024)]).unwrap_or(0);
                if sent == BULK {
                    s.close();
                }
            }
            // The ring buffer hands out at most two contiguous pieces.
            while s.can_recv() {
                let _ = s.recv(|b| {
                    got.extend_from_slice(b);
                    (b.len(), ())
                });
            }
            matches!(s.state(), tcp::State::TimeWait | tcp::State::Closed)
        })
        .await;
    assert!(done, "bulk transfer stalled: sent {sent}, got {}", got.len());
    assert_eq!(got.len(), 8 + BULK);
    assert_eq!(u64::from_be_bytes(got[..8].try_into().unwrap()), BULK as u64);
    assert_eq!(r.conn.calls(), vec![("tcp", sa(PUBLIC, 443)), ("tcp", sa(PUBLIC, 444))]);
}

#[tokio::test(flavor = "multi_thread")]
async fn net_refuses_private_after_dns() {
    let server = pong_server().await;
    let up = fake_dns(&[192, 168, 1, 1]).await;
    let conn = TestConnector::new([(sa(Ipv4Addr::new(192, 168, 1, 1), 80), server)]);
    let mut r = start(HostNets::default(), 16, vec![up], conn, true);
    let q = r.guest.udp(5353);
    r.guest.udp_sock(q).send_slice(b"router.lan", ep(GATEWAY, 53)).unwrap();
    let (answer, _) = r.guest.udp_recv(q, 5).await.expect("no DNS answer");
    // The answer is passed through unfiltered; the connect is what is refused.
    let ip = Ipv4Addr::from(<[u8; 4]>::try_from(&answer[answer.len() - 4..]).unwrap());
    assert_eq!(ip, Ipv4Addr::new(192, 168, 1, 1));
    let h = r.guest.connect(ip, 80, 40001);
    assert!(r.guest.refused(h).await, "expected RST, state {:?}", r.guest.tcp(h).state());
    assert!(r.conn.calls().is_empty(), "connector was called: {:?}", r.conn.calls());
}

#[tokio::test(flavor = "multi_thread")]
async fn net_refuses_host_global_ipv6() {
    let server = pong_server().await;
    let v6: SocketAddr = "[2a01:4f8:1:2::1]:443".parse().unwrap();
    let conn = TestConnector::new([(sa(PUBLIC, 443), server), (v6, server)]);
    // The Mac's own public addresses: a global /64 and a public IPv4.
    let host = HostNets::new(vec![IpAddr::V4(PUBLIC)], vec![("2a01:4f8:1:2::".parse().unwrap(), 64)]);
    let mut r = start(host, 16, vec![], conn, true);
    let h = r.guest.connect(PUBLIC, 443, 40002);
    assert!(r.guest.refused(h).await, "host public IPv4 was reachable");
    // Guest IPv6 is not routed at all: a SYN to the host's /64 goes nowhere.
    let mut f = vec![0xff; 6];
    f.extend_from_slice(&GUEST_MAC.0);
    f.extend_from_slice(&[0x86, 0xdd, 0x60, 0, 0, 0, 0, 20, 6, 64]);
    f.extend_from_slice(&"2a01:4f8:1:2::99".parse::<std::net::Ipv6Addr>().unwrap().octets());
    f.extend_from_slice(&"2a01:4f8:1:2::1".parse::<std::net::Ipv6Addr>().unwrap().octets());
    f.extend_from_slice(&[0x9c, 0x43, 0x01, 0xbb, 0, 0, 0, 1, 0, 0, 0, 0, 0x50, 0x02, 0xff, 0xff, 0, 0, 0, 0]);
    r.guest.dev.sock.send(&f).unwrap();
    r.guest.run_until(1, |_| false).await;
    assert!(r.conn.calls().is_empty(), "connector was called: {:?}", r.conn.calls());
}

#[tokio::test(flavor = "multi_thread")]
async fn udp_to_private_is_dropped() {
    let echo = udp_echo().await;
    let private = [
        Ipv4Addr::new(192, 168, 1, 1),
        Ipv4Addr::new(10, 0, 0, 1),
        Ipv4Addr::new(100, 100, 100, 100),
        Ipv4Addr::new(127, 0, 0, 1),
        Ipv4Addr::new(169, 254, 1, 1),
        Ipv4Addr::BROADCAST,
        GUEST,
    ];
    let mut map: Vec<_> = private.iter().map(|ip| (sa(*ip, 9999), echo)).collect();
    map.push((sa(PUBLIC, 9999), echo));
    let mut r = start(HostNets::default(), 16, vec![], TestConnector::new(map), true);
    let h = r.guest.udp(6000);
    for ip in private {
        r.guest.udp_sock(h).send_slice(b"leak", ep(ip, 9999)).unwrap();
        r.guest.run_until(0, |_| true).await;
    }
    r.guest.udp_sock(h).send_slice(b"ok", ep(PUBLIC, 9999)).unwrap();
    let (data, from) = r.guest.udp_recv(h, 5).await.expect("public UDP got no reply");
    assert_eq!((data.as_slice(), from), (&b"echo:ok"[..], ep(PUBLIC, 9999)));
    assert!(r.guest.udp_recv(h, 1).await.is_none(), "a private destination answered");
    assert_eq!(r.conn.calls(), vec![("udp", sa(PUBLIC, 9999))]);
}

#[tokio::test(flavor = "multi_thread")]
async fn gateway_ports_other_than_dns_are_reset() {
    let up = fake_dns(b"").await;
    let mut r = start(HostNets::default(), 16, vec![up], TestConnector::default(), true);
    for (i, port) in [22u16, 80, 67, 8080].into_iter().enumerate() {
        let h = r.guest.connect(GATEWAY, port, 41000 + i as u16);
        assert!(r.guest.refused(h).await, "gateway port {port} was open");
    }
    assert!(r.conn.calls().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn flow_table_is_bounded() {
    let echo = udp_echo().await;
    let server = pong_server().await;
    let udp_dsts: Vec<_> = (1..=4).map(|p| sa(PUBLIC, 5000 + p)).collect();
    let tcp_dsts: Vec<_> = (1..=3).map(|p| sa(PUBLIC, 6000 + p)).collect();
    let map = udp_dsts.iter().map(|d| (*d, echo)).chain(tcp_dsts.iter().map(|d| (*d, server)));
    let mut r = start(HostNets::default(), 2, vec![], TestConnector::new(map), true);
    let u = r.guest.udp(7000);
    // Three UDP flows in a table of two: the quietest is evicted, all are answered.
    for p in 5001..=5003 {
        r.guest.udp_sock(u).send_slice(b"u", ep(PUBLIC, p)).unwrap();
        assert!(r.guest.udp_recv(u, 5).await.is_some(), "UDP flow {p} not admitted");
    }
    // Two TCP flows evict the UDP ones; a third finds no evictable flow and is reset.
    let a = r.guest.connect(PUBLIC, 6001, 42001);
    let b = r.guest.connect(PUBLIC, 6002, 42002);
    assert_eq!(r.guest.round_trip(a, b"a", 6).await, b"pong:a");
    assert_eq!(r.guest.round_trip(b, b"b", 6).await, b"pong:b");
    let c = r.guest.connect(PUBLIC, 6003, 42003);
    assert!(r.guest.refused(c).await, "a third TCP flow was admitted");
    r.guest.udp_sock(u).send_slice(b"u", ep(PUBLIC, 5004)).unwrap();
    assert!(r.guest.udp_recv(u, 1).await.is_none(), "a UDP flow was admitted into a full table");
    let calls = r.conn.calls();
    assert_eq!(calls.iter().filter(|c| c.0 == "tcp").count(), 2, "{calls:?}");
    assert_eq!(calls.iter().filter(|c| c.0 == "udp").count(), 3, "{calls:?}");
}

/// A valid guest TCP SYN frame to `dst`.
fn syn_frame(dst: Ipv4Addr, port: u16) -> Vec<u8> {
    let tcp = TcpRepr {
        src_port: 43000,
        dst_port: port,
        control: TcpControl::Syn,
        seq_number: TcpSeqNumber(1),
        ack_number: None,
        window_len: 1024,
        window_scale: None,
        max_seg_size: None,
        sack_permitted: false,
        sack_ranges: [None; 3],
        timestamp: None,
        payload: &[],
    };
    let ip = Ipv4Repr {
        src_addr: GUEST,
        dst_addr: dst,
        next_header: IpProtocol::Tcp,
        payload_len: tcp.buffer_len(),
        hop_limit: 64,
    };
    let mut f = vec![0u8; 14 + 20 + tcp.buffer_len()];
    EthernetRepr { src_addr: GUEST_MAC, dst_addr: EthernetAddress::BROADCAST, ethertype: EthernetProtocol::Ipv4 }
        .emit(&mut EthernetFrame::new_unchecked(&mut f[..]));
    let caps = smoltcp::phy::ChecksumCapabilities::default();
    ip.emit(&mut Ipv4Packet::new_unchecked(&mut f[14..]), &caps);
    tcp.emit(&mut TcpPacket::new_unchecked(&mut f[34..]), &IpAddress::Ipv4(GUEST), &IpAddress::Ipv4(dst), &caps);
    f
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_frames_are_dropped() {
    let server = pong_server().await;
    let conn = TestConnector::new([(sa(PUBLIC, 443), server)]);
    let mut r = start(HostNets::default(), 16, vec![], conn, true);
    let raw = r.guest.dev.sock.try_clone().unwrap();
    let send = |f: &[u8]| {
        // A full socket buffer just drops the frame, like the wire would.
        let _ = raw.send(f);
    };
    let syn = syn_frame(PUBLIC, 443);
    for len in 0..syn.len() {
        send(&syn[..len]);
    }
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for i in 0..3000 {
        let len = (next() % 1600) as usize;
        let mut f: Vec<u8> = (0..len).map(|_| next() as u8).collect();
        // Every other frame keeps a plausible Ethernet/IPv4/TCP prefix so parsing goes deep.
        if i % 2 == 0 && f.len() > 40 {
            let keep = (next() % 40) as usize;
            f[..keep].copy_from_slice(&syn[..keep]);
        }
        send(&f);
        if i % 64 == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
    send(&vec![0u8; 9000]);
    let mut huge = syn.clone();
    huge.resize(1600, 0);
    send(&huge);
    assert!(!r.nat.is_finished(), "the NAT stopped on bad frames");
    assert!(r.conn.calls().is_empty(), "a truncated SYN opened a flow: {:?}", r.conn.calls());
    let h = r.guest.connect(PUBLIC, 443, 40003);
    assert_eq!(r.guest.round_trip(h, b"still", 10).await, b"pong:still");
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_returns_when_socket_closes() {
    let r = start(HostNets::default(), 16, vec![], TestConnector::default(), true);
    drop(r.guest);
    let out = tokio::time::timeout(Duration::from_secs(5), r.nat).await;
    assert!(matches!(out, Ok(Ok(Ok(())))), "serve did not return cleanly: {out:?}");
}
