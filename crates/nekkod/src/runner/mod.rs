//! CI runner VMs: the userspace NAT that is a job VM's only network, the
//! host networks it keeps the guest away from, and the physical interface it
//! sends from.

pub mod egress;
pub mod hostnets;
pub mod net;
