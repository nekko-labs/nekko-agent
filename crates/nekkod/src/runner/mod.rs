//! CI runner VMs: the userspace NAT that is a job VM's only network, and the
//! host networks it keeps the guest away from.

pub mod hostnets;
pub mod net;
