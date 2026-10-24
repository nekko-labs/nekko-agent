//! The userspace NAT that is a job VM's only network. `nekko-vm` attaches the
//! guest's virtio-net to one end of a `SOCK_DGRAM` socketpair (one datagram is
//! one raw Ethernet frame); [`serve`] owns the other end. It is the gateway
//! (10.233.0.1, guest 10.233.0.2/24): it answers DHCP and DNS, and forwards the
//! guest's TCP and UDP to the internet from host sockets, slirp-style, with a
//! smoltcp interface in any-IP mode terminating the guest's TCP.
//!
//! SECURITY BOUNDARY: the guest runs untrusted job code. Every new TCP
//! connection and UDP flow is checked with [`guest_may_connect`] on its
//! destination address before any host socket is opened, so a guest reaches
//! only the public internet, never the host, the LAN, Tailscale peers or
//! anything local, whatever its DNS answers say. A refused TCP SYN gets a RST
//! (smoltcp answers it, because no socket listens), a refused UDP datagram is
//! dropped. The gateway itself serves DHCP (67/udp) and DNS (53/udp, 53/tcp,
//! forwarded unchanged to the host's resolvers) and nothing else. Guest IPv6
//! is not routed in P1: every IPv6 frame is dropped. Every buffer, queue and
//! table is bounded, and no guest byte is trusted without a checked parse.
//!
//! The file is self-contained (no `crate::` paths) because
//! `tests/runner_net.rs` includes it with `#[path]`.

use nekko_runner::{HostNets, guest_may_connect};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, ChecksumCapabilities, Device, DeviceCapabilities, Medium};
use smoltcp::socket::tcp;
use smoltcp::time::Instant;
use smoltcp::wire::{
    DhcpMessageType, DhcpOption, DhcpPacket, DhcpRepr, EthernetAddress, EthernetFrame, EthernetProtocol, EthernetRepr,
    HardwareAddress, IpAddress, IpCidr, IpListenEndpoint, IpProtocol, Ipv4Packet, Ipv4Repr, TcpPacket, TcpRepr,
    UdpPacket, UdpRepr,
};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket, UnixDatagram};
use tokio::sync::{Notify, Semaphore, mpsc};
use tokio::task::JoinHandle;

pub const GATEWAY: Ipv4Addr = Ipv4Addr::new(10, 233, 0, 1);
pub const GUEST: Ipv4Addr = Ipv4Addr::new(10, 233, 0, 2);
/// Locally administered, so it can never collide with a real NIC.
const GATEWAY_MAC: EthernetAddress = EthernetAddress([0x02, 0x6e, 0x6b, 0x00, 0x00, 0x01]);
/// MTU 1500 plus the Ethernet header; anything longer from the guest is dropped.
const MAX_FRAME: usize = 1514;
/// The largest UDP payload one frame carries; longer replies are dropped, not fragmented.
const MAX_UDP: usize = 1500 - 20 - 8;
/// Per TCP flow, each direction. With the default 256 flows that bounds socket memory to 8 MiB per VM.
const TCP_BUF: usize = 16 * 1024;
/// Host<->guest chunks in flight per TCP flow direction (`CHUNKS` of up to `CHUNK` bytes).
const CHUNK: usize = 8 * 1024;
const CHUNKS: usize = 2;
/// Datagrams queued toward one UDP flow's host socket; more are dropped, as on a real link.
const UDP_QUEUE: usize = 32;
/// UDP has no close, so a flow ends when it has been quiet this long.
const UDP_IDLE: Duration = Duration::from_secs(60);
const DNS_MAX: usize = 4096;
const DNS_INFLIGHT: usize = 64;
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
/// Frames waiting to go to the guest; smoltcp sees a full device and holds its own.
const TX_QUEUE: usize = 512;
const LEASE_SECS: u32 = 86_400;

/// Each flow holds one host socket (a file descriptor), so a running VM can
/// use up to `max_flows` fds plus 64 for DNS. nekkod must raise
/// RLIMIT_NOFILE at startup to cover that for every VM it runs.
pub struct NetConfig {
    /// TCP connections plus UDP flows at once (256 per VM by default).
    pub max_flows: usize,
    /// The host's resolvers; the gateway's DNS forwards to these, in order.
    pub dns_upstream: Vec<SocketAddr>,
    /// How long a host TCP connect may take before the guest gets RST and
    /// the flow's slot is freed (15 s by default).
    pub connect_timeout: Duration,
    /// Spike and tests only, never in the shipped daemon (decision 0022: no
    /// host-to-guest path): each connection accepted on this listener is
    /// forwarded to the guest's port, from a smoltcp client socket.
    #[cfg(any(test, feature = "spike"))]
    pub forward: Option<(std::net::TcpListener, u16)>,
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            max_flows: 256,
            dns_upstream: vec![],
            connect_timeout: Duration::from_secs(15),
            #[cfg(any(test, feature = "spike"))]
            forward: None,
        }
    }
}

/// How the NAT opens host sockets. Only called for destinations the policy
/// allowed; tests swap in one that maps public test addresses to local
/// servers, and the policy itself is never stubbed.
pub trait Connector: Send + Sync + 'static {
    fn tcp(&self, dst: SocketAddr) -> impl Future<Output = io::Result<TcpStream>> + Send;
    /// A socket connected to `dst`, so only `dst`'s replies come back.
    fn udp(&self, dst: SocketAddr) -> impl Future<Output = io::Result<UdpSocket>> + Send;
}

/// The real connector: plain host sockets.
pub struct Direct;

impl Connector for Direct {
    async fn tcp(&self, dst: SocketAddr) -> io::Result<TcpStream> {
        TcpStream::connect(dst).await
    }
    async fn udp(&self, dst: SocketAddr) -> io::Result<UdpSocket> {
        connected_udp(dst).await
    }
}

async fn connected_udp(dst: SocketAddr) -> io::Result<UdpSocket> {
    let any: SocketAddr = if dst.is_ipv4() { ([0, 0, 0, 0], 0).into() } else { ([0u16; 8], 0).into() };
    let s = UdpSocket::bind(any).await?;
    s.connect(dst).await?;
    Ok(s)
}

/// Runs the NAT on `sock` until the VM side closes it (or it fails).
pub async fn serve(sock: UnixDatagram, host: Arc<RwLock<HostNets>>, cfg: NetConfig) -> io::Result<()> {
    serve_with(sock, host, cfg, Direct).await
}

/// [`serve`] with the host sockets opened through `connector`.
pub async fn serve_with<C: Connector>(
    sock: UnixDatagram,
    host: Arc<RwLock<HostNets>>,
    cfg: NetConfig,
    connector: C,
) -> io::Result<()> {
    widen_buffers(&sock)?;
    let mut nat = Nat::new(host, cfg, Arc::new(connector));
    #[cfg(any(test, feature = "spike"))]
    nat.start_forward()?;
    let wake = nat.wake.clone();
    let mut buf = vec![0u8; 64 * 1024];
    let mut peer_check = tokio::time::interval(Duration::from_secs(1));
    loop {
        nat.pump();
        nat.poll();
        while let Some(frame) = nat.link.tx.pop_front() {
            match sock.send(&frame).await {
                Ok(_) => {}
                // macOS reports a full peer buffer as ENOBUFS: drop the frame, TCP resends.
                Err(e) if e.raw_os_error() == Some(libc::ENOBUFS) => tokio::task::yield_now().await,
                Err(e) => return closed_or(e),
            }
        }
        let delay = nat
            .iface
            .poll_delay(now(), &nat.sockets)
            .map_or(Duration::from_secs(1), |d| Duration::from_micros(d.total_micros()))
            .min(Duration::from_secs(1));
        tokio::select! {
            r = sock.recv(&mut buf) => match r {
                Ok(n) => nat.on_frame(&buf[..n]),
                Err(e) => return closed_or(e),
            },
            _ = wake.notified() => {}
            _ = tokio::time::sleep(delay) => {}
            // A datagram socket has no EOF; macOS signals a closed peer once, this catches the rest.
            _ = peer_check.tick() => if sock.peer_addr().is_err() { return Ok(()) },
        }
    }
}

/// Sizes a frame socket's buffers for bulk traffic. macOS gives a unix
/// datagram socket 4 KiB of receive space (two frames), and a send into a
/// full receiver fails with ENOBUFS, so without this TCP crawls on
/// retransmits. Call it on both ends: `serve` does its own, whoever creates
/// the socketpair does the helper's.
pub fn widen_buffers(sock: &impl std::os::fd::AsRawFd) -> io::Result<()> {
    for (opt, size) in [(libc::SO_RCVBUF, 4 << 20), (libc::SO_SNDBUF, 1 << 20)] {
        let size: libc::c_int = size;
        // SAFETY: a valid fd and a c_int option value of the right length.
        let rc = unsafe {
            libc::setsockopt(
                sock.as_raw_fd(),
                libc::SOL_SOCKET,
                opt,
                (&size as *const libc::c_int).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The peer going away is the normal end of a VM, not an error.
fn closed_or(e: io::Error) -> io::Result<()> {
    match e.raw_os_error() {
        Some(libc::ECONNRESET | libc::ENOTCONN | libc::EPIPE | libc::ECONNREFUSED | libc::EDESTADDRREQ) => Ok(()),
        _ => Err(e),
    }
}

fn now() -> Instant {
    Instant::now()
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Key {
    /// (guest port, destination)
    Tcp(u16, SocketAddrV4),
    Udp(u16, SocketAddrV4),
}

enum Msg {
    Data(Vec<u8>),
    Eof,
    Abort,
}

struct TcpFlow {
    handle: SocketHandle,
    /// Dropped once the guest has sent FIN, which shuts the host side's write half.
    to_host: Option<mpsc::Sender<Vec<u8>>>,
    from_host: mpsc::Receiver<Msg>,
    pending: Vec<u8>,
    sent: usize,
    host_eof: bool,
}

enum Kind {
    Tcp(TcpFlow),
    Udp(mpsc::Sender<Vec<u8>>),
}

struct Flow {
    kind: Kind,
    task: JoinHandle<()>,
    last: std::time::Instant,
}

/// Host sockets live in the flow tasks; a detached task would keep its
/// socket open after `serve` returns, so they all end with the NAT.
impl<C> Drop for Nat<C> {
    fn drop(&mut self) {
        for flow in self.flows.values() {
            flow.task.abort();
        }
        #[cfg(any(test, feature = "spike"))]
        if let Some(f) = &self.forward {
            f.task.abort();
        }
    }
}

struct Nat<C> {
    iface: Interface,
    link: Link,
    sockets: SocketSet<'static>,
    flows: HashMap<Key, Flow>,
    host: Arc<RwLock<HostNets>>,
    cfg: NetConfig,
    connector: Arc<C>,
    wake: Arc<Notify>,
    /// Replies from UDP flows and DNS: (guest port, source, payload).
    udp_back_tx: mpsc::Sender<(u16, SocketAddrV4, Vec<u8>)>,
    udp_back_rx: mpsc::Receiver<(u16, SocketAddrV4, Vec<u8>)>,
    dns_slots: Arc<Semaphore>,
    guest_mac: Option<EthernetAddress>,
    /// DHCP leases the one guest address to the first client MAC seen.
    lease_mac: Option<EthernetAddress>,
    last_sweep: std::time::Instant,
    #[cfg(any(test, feature = "spike"))]
    forward: Option<Forward>,
}

/// The spike's host-to-guest port forward (see [`NetConfig::forward`]).
#[cfg(any(test, feature = "spike"))]
struct Forward {
    accepted: mpsc::Receiver<TcpStream>,
    guest_port: u16,
    next_port: u16,
    task: JoinHandle<()>,
}

impl<C: Connector> Nat<C> {
    fn new(host: Arc<RwLock<HostNets>>, cfg: NetConfig, connector: Arc<C>) -> Self {
        let mut link = Link { rx: None, tx: VecDeque::new() };
        let mut config = Config::new(HardwareAddress::Ethernet(GATEWAY_MAC));
        config.random_seed =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        let mut iface = Interface::new(config, &mut link, now());
        iface.update_ip_addrs(|a| {
            let _ = a.push(IpCidr::new(IpAddress::Ipv4(GATEWAY), 24));
        });
        // A default route through our own address plus any-IP makes smoltcp
        // accept the guest's packets for every destination, so a socket can
        // listen on the exact address the guest dialed.
        let _ = iface.routes_mut().add_default_ipv4_route(GATEWAY);
        iface.set_any_ip(true);
        let (udp_back_tx, udp_back_rx) = mpsc::channel(256);
        Self {
            iface,
            link,
            sockets: SocketSet::new(vec![]),
            flows: HashMap::new(),
            host,
            cfg,
            connector,
            wake: Arc::new(Notify::new()),
            udp_back_tx,
            udp_back_rx,
            dns_slots: Arc::new(Semaphore::new(DNS_INFLIGHT)),
            guest_mac: None,
            lease_mac: None,
            last_sweep: std::time::Instant::now(),
            #[cfg(any(test, feature = "spike"))]
            forward: None,
        }
    }

    fn poll(&mut self) {
        self.iface.poll(now(), &mut self.link, &mut self.sockets);
    }

    /// Fails closed: a poisoned lock refuses everything.
    fn allowed(&self, dst: Ipv4Addr) -> bool {
        self.host.read().map(|h| guest_may_connect(dst.into(), &h)).unwrap_or(false)
    }

    /// One frame from the guest. Policy and the gateway's own services are
    /// decided here; only ARP, ICMP to the gateway and TCP reach smoltcp.
    fn on_frame(&mut self, frame: &[u8]) {
        if frame.len() > MAX_FRAME {
            return;
        }
        let Ok(eth) = EthernetFrame::new_checked(frame) else { return };
        let dst_mac = eth.dst_addr();
        if dst_mac != GATEWAY_MAC && !dst_mac.is_broadcast() {
            return;
        }
        match eth.ethertype() {
            EthernetProtocol::Arp => self.feed_smoltcp(frame),
            EthernetProtocol::Ipv4 => self.on_ipv4(eth.src_addr(), eth.payload(), frame),
            // Guest IPv6 is not routed in P1 (no RA, no host-side v6 sockets).
            _ => {}
        }
    }

    fn on_ipv4(&mut self, src_mac: EthernetAddress, packet: &[u8], frame: &[u8]) {
        let checksum = ChecksumCapabilities::default();
        let Ok(pkt) = Ipv4Packet::new_checked(packet) else { return };
        let Ok(ip) = Ipv4Repr::parse(&pkt, &checksum) else { return };
        if pkt.more_frags() || pkt.frag_offset() != 0 {
            return;
        }
        let payload = pkt.payload();
        if ip.next_header == IpProtocol::Udp {
            let Ok(udp_pkt) = UdpPacket::new_checked(payload) else { return };
            let Ok(udp) = UdpRepr::parse(&udp_pkt, &ip.src_addr.into(), &ip.dst_addr.into(), &checksum) else {
                return;
            };
            if udp.dst_port == 67 && udp.src_port == 68 {
                return self.dhcp(udp_pkt.payload());
            }
        }
        // Past DHCP, only the guest's own address may speak.
        if ip.src_addr != GUEST {
            return;
        }
        self.guest_mac = Some(src_mac);
        match ip.next_header {
            IpProtocol::Tcp => self.on_tcp(&ip, payload, frame),
            IpProtocol::Udp => self.on_udp(&ip, payload),
            IpProtocol::Icmp if ip.dst_addr == GATEWAY => self.feed_smoltcp(frame),
            _ => {}
        }
    }

    fn on_tcp(&mut self, ip: &Ipv4Repr, payload: &[u8], frame: &[u8]) {
        let Ok(pkt) = TcpPacket::new_checked(payload) else { return };
        let Ok(tcp) = TcpRepr::parse(&pkt, &ip.src_addr.into(), &ip.dst_addr.into(), &ChecksumCapabilities::default())
        else {
            return;
        };
        let dst = SocketAddrV4::new(ip.dst_addr, tcp.dst_port);
        let key = Key::Tcp(tcp.src_port, dst);
        let new_syn = tcp.control == smoltcp::wire::TcpControl::Syn && tcp.ack_number.is_none();
        if new_syn && tcp.dst_port != 0 && !self.flows.contains_key(&key) {
            if dst.ip() == &GATEWAY {
                if let (53, Some(&up)) = (dst.port(), self.cfg.dns_upstream.first()) {
                    self.open_tcp(key, TcpStream::connect(up));
                }
            } else if self.allowed(*dst.ip()) {
                let c = self.connector.clone();
                self.open_tcp(key, async move { c.tcp(dst.into()).await });
            }
        }
        // With no flow opened, no socket listens and smoltcp answers RST.
        self.feed_smoltcp(frame);
    }

    fn on_udp(&mut self, ip: &Ipv4Repr, payload: &[u8]) {
        // Already checksum- and length-checked in on_ipv4.
        let Ok(pkt) = UdpPacket::new_checked(payload) else { return };
        let (src_port, data) = (pkt.src_port(), pkt.payload());
        let dst = SocketAddrV4::new(ip.dst_addr, pkt.dst_port());
        if dst.ip() == &GATEWAY {
            if dst.port() == 53 {
                self.dns(src_port, data);
            }
            return;
        }
        let key = Key::Udp(src_port, dst);
        if !self.flows.contains_key(&key) {
            if dst.port() == 0 || !self.allowed(*dst.ip()) || !self.make_room() {
                return;
            }
            let (tx, rx) = mpsc::channel(UDP_QUEUE);
            let task = tokio::spawn(udp_host(
                self.connector.clone(),
                dst,
                src_port,
                rx,
                self.udp_back_tx.clone(),
                self.wake.clone(),
            ));
            self.flows.insert(key, Flow { kind: Kind::Udp(tx), task, last: std::time::Instant::now() });
        }
        if let Some(flow) = self.flows.get_mut(&key) {
            flow.last = std::time::Instant::now();
            if let Kind::Udp(tx) = &flow.kind {
                let _ = tx.try_send(data.to_vec());
            }
        }
    }

    /// Frees a slot if the table is full by evicting the longest-quiet UDP
    /// flow. TCP flows end by FIN or RST, so they are never evicted: a table
    /// full of them refuses new flows.
    fn make_room(&mut self) -> bool {
        if self.flows.len() < self.cfg.max_flows {
            return true;
        }
        let oldest = self
            .flows
            .iter()
            .filter(|(_, f)| matches!(f.kind, Kind::Udp(_)))
            .min_by_key(|(_, f)| f.last)
            .map(|(k, _)| *k);
        match oldest {
            Some(k) => {
                self.remove(k);
                true
            }
            None => false,
        }
    }

    fn open_tcp<F>(&mut self, key: Key, connect: F)
    where
        F: Future<Output = io::Result<TcpStream>> + Send + 'static,
    {
        let Key::Tcp(_, dst) = key else { return };
        if !self.make_room() {
            return;
        }
        let mut sock =
            tcp::Socket::new(tcp::SocketBuffer::new(vec![0; TCP_BUF]), tcp::SocketBuffer::new(vec![0; TCP_BUF]));
        let ep = IpListenEndpoint { addr: Some(IpAddress::Ipv4(*dst.ip())), port: dst.port() };
        if sock.listen(ep).is_err() {
            return;
        }
        self.attach(key, sock, connect);
    }

    /// Adds a smoltcp socket for `key` and the host task that connects with `connect` and copies both ways.
    fn attach<F>(&mut self, key: Key, sock: tcp::Socket<'static>, connect: F)
    where
        F: Future<Output = io::Result<TcpStream>> + Send + 'static,
    {
        let handle = self.sockets.add(sock);
        let limit = self.cfg.connect_timeout;
        let connect = async move {
            tokio::time::timeout(limit, connect).await.unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()))
        };
        let (to_host, to_host_rx) = mpsc::channel(CHUNKS);
        let (from_host_tx, from_host) = mpsc::channel(CHUNKS);
        let task = tokio::spawn(tcp_host(connect, to_host_rx, from_host_tx, self.wake.clone()));
        let flow = TcpFlow { handle, to_host: Some(to_host), from_host, pending: vec![], sent: 0, host_eof: false };
        self.flows.insert(key, Flow { kind: Kind::Tcp(flow), task, last: std::time::Instant::now() });
    }

    #[cfg(any(test, feature = "spike"))]
    fn start_forward(&mut self) -> io::Result<()> {
        let Some((listener, guest_port)) = self.cfg.forward.take() else { return Ok(()) };
        listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let (tx, accepted) = mpsc::channel(4);
        let wake = self.wake.clone();
        let task = tokio::spawn(async move {
            while let Ok((s, _)) = listener.accept().await {
                if tx.send(s).await.is_err() {
                    return;
                }
                wake.notify_one();
            }
        });
        self.forward = Some(Forward { accepted, guest_port, next_port: 49152, task });
        Ok(())
    }

    /// Opens a smoltcp client socket to the guest for each accepted host connection.
    #[cfg(any(test, feature = "spike"))]
    fn accept_forwards(&mut self) {
        let Some(f) = &mut self.forward else { return };
        let mut streams = vec![];
        while let Ok(s) = f.accepted.try_recv() {
            f.next_port = f.next_port.checked_add(1).unwrap_or(49152);
            streams.push((s, f.guest_port, f.next_port));
        }
        for (stream, guest_port, local_port) in streams {
            let key = Key::Tcp(guest_port, SocketAddrV4::new(GATEWAY, local_port));
            if self.flows.contains_key(&key) || !self.make_room() {
                continue;
            }
            let mut sock =
                tcp::Socket::new(tcp::SocketBuffer::new(vec![0; TCP_BUF]), tcp::SocketBuffer::new(vec![0; TCP_BUF]));
            if sock.connect(self.iface.context(), (IpAddress::Ipv4(GUEST), guest_port), local_port).is_err() {
                continue;
            }
            self.attach(key, sock, std::future::ready(Ok(stream)));
        }
    }

    fn remove(&mut self, key: Key) {
        if let Some(flow) = self.flows.remove(&key) {
            flow.task.abort();
            if let Kind::Tcp(t) = flow.kind {
                self.sockets.remove(t.handle);
            }
        }
    }

    /// Moves bytes between smoltcp sockets and host tasks, delivers UDP
    /// replies, and ends finished or idle flows.
    fn pump(&mut self) {
        #[cfg(any(test, feature = "spike"))]
        self.accept_forwards();
        let mut done = vec![];
        for (key, flow) in &mut self.flows {
            let Kind::Tcp(t) = &mut flow.kind else { continue };
            let sock = self.sockets.get_mut::<tcp::Socket>(t.handle);
            if pump_tcp(sock, t) {
                flow.last = std::time::Instant::now();
            }
            use tcp::State::*;
            // Listen means smoltcp did not take the SYN; do not leave a socket that would catch another one.
            if matches!(sock.state(), Closed | TimeWait | Listen) {
                done.push(*key);
            }
        }
        let mut budget = 256;
        while budget > 0 {
            let Ok((port, src, data)) = self.udp_back_rx.try_recv() else { break };
            budget -= 1;
            if let Some(flow) = self.flows.get_mut(&Key::Udp(port, src)) {
                flow.last = std::time::Instant::now();
            }
            if let Some(mac) = self.guest_mac {
                self.emit(udp_frame(mac, src, SocketAddrV4::new(GUEST, port), &data));
            }
        }
        if budget == 0 {
            self.wake.notify_one();
        }
        if self.last_sweep.elapsed() >= Duration::from_secs(1) {
            self.last_sweep = std::time::Instant::now();
            for (key, flow) in &self.flows {
                if let Kind::Udp(tx) = &flow.kind
                    && (flow.last.elapsed() >= UDP_IDLE || tx.is_closed())
                {
                    done.push(*key);
                }
            }
        }
        if !done.is_empty() {
            // An aborted socket is already Closed but sends its RST on the
            // next poll; removing it first would leave the guest hanging.
            self.poll();
        }
        for key in done {
            self.remove(key);
        }
    }

    fn emit(&mut self, frame: Option<Vec<u8>>) {
        if let Some(f) = frame
            && self.link.tx.len() < TX_QUEUE
        {
            self.link.tx.push_back(f);
        }
    }

    fn feed_smoltcp(&mut self, frame: &[u8]) {
        self.link.rx = Some(frame.to_vec());
        // Polled right away so a new flow's SYN reaches its listening socket
        // before any other frame can.
        self.poll();
    }

    fn dns(&mut self, guest_port: u16, query: &[u8]) {
        if query.is_empty() || query.len() > DNS_MAX || self.cfg.dns_upstream.is_empty() {
            return;
        }
        let Ok(slot) = self.dns_slots.clone().try_acquire_owned() else { return };
        let (query, upstream, back, wake) =
            (query.to_vec(), self.cfg.dns_upstream.clone(), self.udp_back_tx.clone(), self.wake.clone());
        tokio::spawn(async move {
            let _slot = slot;
            let mut buf = vec![0u8; DNS_MAX];
            for up in upstream.iter().take(3) {
                let Ok(s) = connected_udp(*up).await else { continue };
                if s.send(&query).await.is_err() {
                    continue;
                }
                if let Ok(Ok(n)) = tokio::time::timeout(DNS_TIMEOUT, s.recv(&mut buf)).await {
                    let _ = back.send((guest_port, SocketAddrV4::new(GATEWAY, 53), buf[..n].to_vec())).await;
                    wake.notify_one();
                    return;
                }
            }
        });
    }

    fn dhcp(&mut self, payload: &[u8]) {
        let Ok(pkt) = DhcpPacket::new_checked(payload) else { return };
        let Ok(req) = DhcpRepr::parse(&pkt) else { return };
        let mac = req.client_hardware_address;
        if *self.lease_mac.get_or_insert(mac) != mac {
            return;
        }
        let wrong_ip =
            req.requested_ip.is_some_and(|ip| ip != GUEST) || req.server_identifier.is_some_and(|s| s != GATEWAY);
        let message_type = match req.message_type {
            DhcpMessageType::Discover => DhcpMessageType::Offer,
            // A client rebooting with a lease from another network is told no, so it starts over.
            DhcpMessageType::Request if wrong_ip => DhcpMessageType::Nak,
            DhcpMessageType::Request => DhcpMessageType::Ack,
            _ => return,
        };
        let nak = message_type == DhcpMessageType::Nak;
        let dns_option = [DhcpOption { kind: 6, data: &GATEWAY.octets() }];
        let reply = DhcpRepr {
            message_type,
            transaction_id: req.transaction_id,
            secs: 0,
            client_hardware_address: mac,
            client_ip: Ipv4Addr::UNSPECIFIED,
            your_ip: if nak { Ipv4Addr::UNSPECIFIED } else { GUEST },
            server_ip: Ipv4Addr::UNSPECIFIED,
            router: (!nak).then_some(GATEWAY),
            subnet_mask: (!nak).then_some(Ipv4Addr::new(255, 255, 255, 0)),
            relay_agent_ip: Ipv4Addr::UNSPECIFIED,
            broadcast: false,
            requested_ip: None,
            client_identifier: None,
            server_identifier: Some(GATEWAY),
            parameter_request_list: None,
            dns_servers: None,
            max_size: None,
            lease_duration: (!nak).then_some(LEASE_SECS),
            renew_duration: None,
            rebind_duration: None,
            additional_options: if nak { &[] } else { &dns_option },
        };
        // BOOTP's 300-byte minimum; the tail is Pad options.
        let mut buf = vec![0u8; reply.buffer_len().max(300)];
        if reply.emit(&mut DhcpPacket::new_unchecked(&mut buf[..])).is_err() {
            return;
        }
        let to = SocketAddrV4::new(Ipv4Addr::BROADCAST, 68);
        self.emit(udp_frame(mac, SocketAddrV4::new(GATEWAY, 67), to, &buf));
    }
}

/// Moves what fits each way for one TCP flow; true if any bytes moved.
fn pump_tcp(sock: &mut tcp::Socket, t: &mut TcpFlow) -> bool {
    let mut moved = false;
    // Guest to host: only as much as the bounded channel takes; the rest
    // stays in smoltcp's receive buffer, which closes the guest's window.
    if let Some(tx) = &t.to_host {
        while sock.can_recv() {
            let Ok(permit) = tx.try_reserve() else { break };
            match sock.recv(|b| {
                let n = b.len().min(CHUNK);
                (n, b[..n].to_vec())
            }) {
                Ok(chunk) if !chunk.is_empty() => {
                    permit.send(chunk);
                    moved = true;
                }
                _ => break,
            }
        }
        use tcp::State::*;
        if matches!(sock.state(), CloseWait | LastAck | Closing | TimeWait | Closed) && !sock.can_recv() {
            t.to_host = None;
        }
    }
    // Host to guest: one pending chunk at a time, only into free send buffer.
    loop {
        if t.sent < t.pending.len() {
            match sock.send_slice(&t.pending[t.sent..]) {
                Ok(n) if n > 0 => {
                    t.sent += n;
                    moved = true;
                    continue;
                }
                _ => break,
            }
        }
        match t.from_host.try_recv() {
            Ok(Msg::Data(d)) => (t.pending, t.sent) = (d, 0),
            Ok(Msg::Eof) => {
                t.host_eof = true;
                sock.close();
            }
            Ok(Msg::Abort) => {
                sock.abort();
                break;
            }
            Err(mpsc::error::TryRecvError::Disconnected) if !t.host_eof => {
                sock.abort();
                break;
            }
            Err(_) => break,
        }
    }
    moved
}

/// The host side of one TCP flow: connect, then copy both ways. Bounded
/// channels give backpressure; a failure on either side resets the guest.
async fn tcp_host<F>(connect: F, mut to_host: mpsc::Receiver<Vec<u8>>, from_host: mpsc::Sender<Msg>, wake: Arc<Notify>)
where
    F: Future<Output = io::Result<TcpStream>>,
{
    let stream = match connect.await {
        Ok(s) => s,
        Err(_) => {
            let _ = from_host.send(Msg::Abort).await;
            wake.notify_one();
            return;
        }
    };
    let (mut r, mut w) = stream.into_split();
    let up = async {
        while let Some(chunk) = to_host.recv().await {
            if w.write_all(&chunk).await.is_err() {
                let _ = from_host.send(Msg::Abort).await;
                wake.notify_one();
                return;
            }
            // Room in the channel again: let the loop drain smoltcp.
            wake.notify_one();
        }
        let _ = w.shutdown().await;
    };
    let down = async {
        let mut buf = vec![0u8; CHUNK];
        loop {
            let msg = match r.read(&mut buf).await {
                Ok(0) => Msg::Eof,
                Ok(n) => Msg::Data(buf[..n].to_vec()),
                Err(_) => Msg::Abort,
            };
            let last = !matches!(msg, Msg::Data(_));
            if from_host.send(msg).await.is_err() {
                return;
            }
            wake.notify_one();
            if last {
                return;
            }
        }
    };
    tokio::join!(up, down);
}

/// The host side of one UDP flow; ends on a socket error, and the sweep
/// removes the flow.
async fn udp_host<C: Connector>(
    connector: Arc<C>,
    dst: SocketAddrV4,
    guest_port: u16,
    mut out: mpsc::Receiver<Vec<u8>>,
    back: mpsc::Sender<(u16, SocketAddrV4, Vec<u8>)>,
    wake: Arc<Notify>,
) {
    let Ok(s) = connector.udp(dst.into()).await else { return };
    // One byte more than fits a frame, so an oversized reply shows as such instead of truncating.
    let mut buf = vec![0u8; MAX_UDP + 1];
    loop {
        tokio::select! {
            m = out.recv() => match m {
                Some(p) => { let _ = s.send(&p).await; }
                None => return,
            },
            r = s.recv(&mut buf) => match r {
                Ok(n) if n <= MAX_UDP => {
                    if back.send((guest_port, dst, buf[..n].to_vec())).await.is_err() {
                        return;
                    }
                    wake.notify_one();
                }
                Ok(_) => {}
                Err(_) => return,
            },
        }
    }
}

/// An Ethernet/IPv4/UDP frame from the gateway side to the guest.
fn udp_frame(dst_mac: EthernetAddress, src: SocketAddrV4, dst: SocketAddrV4, payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() > MAX_UDP {
        return None;
    }
    let checksum = ChecksumCapabilities::default();
    let udp_len = 8 + payload.len();
    let ip = Ipv4Repr {
        src_addr: *src.ip(),
        dst_addr: *dst.ip(),
        next_header: IpProtocol::Udp,
        payload_len: udp_len,
        hop_limit: 64,
    };
    let mut buf = vec![0u8; 14 + 20 + udp_len];
    EthernetRepr { src_addr: GATEWAY_MAC, dst_addr: dst_mac, ethertype: EthernetProtocol::Ipv4 }
        .emit(&mut EthernetFrame::new_unchecked(&mut buf[..]));
    ip.emit(&mut Ipv4Packet::new_unchecked(&mut buf[14..]), &checksum);
    UdpRepr { src_port: src.port(), dst_port: dst.port() }.emit(
        &mut UdpPacket::new_unchecked(&mut buf[34..]),
        &IpAddress::Ipv4(*src.ip()),
        &IpAddress::Ipv4(*dst.ip()),
        payload.len(),
        |p| p.copy_from_slice(payload),
        &checksum,
    );
    Some(buf)
}

/// smoltcp's view of the link: one frame in at a time (fed by `on_frame`),
/// frames out into a bounded queue that `serve` sends.
struct Link {
    rx: Option<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl phy::RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl phy::TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0u8; len];
        let r = f(&mut buf);
        if self.0.len() < TX_QUEUE {
            self.0.push_back(buf);
        }
        r
    }
}

impl Device for Link {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;

    fn receive(&mut self, _: Instant) -> Option<(Rx, Tx<'_>)> {
        let frame = self.rx.take()?;
        Some((Rx(frame), Tx(&mut self.tx)))
    }

    fn transmit(&mut self, _: Instant) -> Option<Tx<'_>> {
        (self.tx.len() < TX_QUEUE).then_some(Tx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = MAX_FRAME;
        caps
    }
}
