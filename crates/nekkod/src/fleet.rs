//! Fleet connections between computers of the same account (decision 0102),
//! wired between Nekko Cloud (`nekko_cloud::fleet_link`) and remote access
//! (`nekko_remote::fleet`):
//!
//! - this computer's gate: a fleet HELLO is checked against the account's
//!   current keys, its record and the org sharing switch;
//! - the connecting side's signer: every HELLO to another computer of the
//!   account carries a proof sealed under the account keyring;
//! - the connect block this computer publishes while remote access is on;
//! - a watch that cuts off fleet devices, and drops this desktop's own fleet
//!   links, as soon as the account no longer allows them.

use crate::computers::Computers;
use crate::hub::Hub;
use crate::remote::Remote;
use nekko_cloud::{Cloud, ConnectInfo, FleetAdmitted, HelloBinding};
use nekko_remote::fleet::{Admitted, Binding, FleetGate, FleetSigner};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// How often fleet connections are checked again with nothing else happening.
const RECHECK_EVERY: Duration = Duration::from_secs(15);

fn hello_binding(b: &Binding) -> HelloBinding<'_> {
    HelloBinding {
        room: &b.room,
        challenge: &b.challenge,
        host_eph: &b.host_eph,
        client_eph: &b.client_eph,
        hello_key: &b.hello_key,
    }
}

/// This computer's gate: Nekko Cloud's local check.
pub struct CloudGate(pub Arc<Cloud>);

impl FleetGate for CloudGate {
    fn admit(&self, fleet: &Value, b: &Binding) -> Result<Admitted, &'static str> {
        let a = self.0.fleet_admit(fleet, &hello_binding(b))?;
        Ok(Admitted { device_id: a.device_id, org_id: a.org_id, key_id: a.key_id, name: a.name })
    }

    fn still(&self, a: &Admitted) -> bool {
        self.0.fleet_still(&FleetAdmitted {
            device_id: a.device_id.clone(),
            org_id: a.org_id.clone(),
            key_id: a.key_id,
            name: a.name.clone(),
        })
    }
}

/// Nekko Cloud Relay tickets for a relay room, from this computer's Nekko Cloud
/// account (decision 0116). A Free account is told it needs Pro.
pub fn relay_tickets(cloud: Arc<Cloud>) -> crate::remote::RelayTickets {
    Arc::new(move |room: String| {
        let cloud = cloud.clone();
        let access: nekko_remote::Access = Arc::new(move || {
            let (cloud, room) = (cloud.clone(), room.clone());
            Box::pin(async move {
                let (ticket, renew_after) = cloud.relay_ticket("agent", Some(&room)).await?;
                Ok(nekko_remote::AccessTicket { ticket, renew_after })
            })
        });
        access
    })
}

/// The signer for links to computers of this account found in `org_id`.
pub fn signer(cloud: Arc<Cloud>, org_id: String) -> FleetSigner {
    Arc::new(move |b: &Binding| cloud.fleet_hello(&org_id, &hello_binding(b)))
}

/// What this computer puts in its descriptor's connect block: its relay agent,
/// while remote access is on.
pub fn connect_info(remote: &Remote) -> Option<ConnectInfo> {
    let p = remote.pairing();
    let text = |k: &str| p.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    ConnectInfo::new(vec![text("relayUrl")?], text("room")?, text("key")?, text("hostKey")?)
}

/// Install the gate and keep fleet connections honest: on every account change
/// and on a timer, cut off devices the account no longer allows, and drop this
/// desktop's own fleet links once it is signed out or locked.
pub fn start(remote: Arc<Remote>, computers: Arc<Computers>, cloud: Arc<Cloud>, hub: &Hub) {
    remote.set_fleet_gate(Arc::new(CloudGate(cloud.clone())));
    remote.set_relay_tickets(relay_tickets(cloud.clone()));
    computers.set_cloud(cloud.clone());
    let mut events = hub.subscribe();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECHECK_EVERY);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                ev = events.recv() => match ev {
                    Ok(ev) if ev.text.starts_with(&format!(r#"{{"channel":"{}""#, nekko_cloud::EVENT)) => {}
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => return,
                },
            }
            let r = remote.clone();
            // The vault may be the OS key store: off the async workers.
            let cut = tokio::task::spawn_blocking(move || r.recheck_fleet()).await.unwrap_or_default();
            for id in cut {
                crate::logs::note(&format!("nekkod: cut off fleet connection {id}: the account no longer allows it"));
            }
            computers.drop_fleet_unless_ready().await;
        }
    });
}
