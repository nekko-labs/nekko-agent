//! Step-up on the desktop and the Local Web UI (SK-4, SK-5): Settings →
//! Security's channels (`security:*`) and the check that runs before a
//! guarded call from either surface.
//!
//! The computer is the relying party (decision 0018) and this daemon is the
//! one verifier, for the desktop app, the Local Web UI and (through the phone
//! gate, `nekko_remote::phone`) the phones. `security.json` is the phone
//! gate's file, read and written through the same store.
//!
//! A guarded call (`STEP_UP_DESKTOP_GUARDED` in `packages/shared/src/step-up.ts`,
//! read from `phone-access.json`) that arrives while step-up is on and not
//! covered is refused `step-up-required`, naming its action class. The page
//! then shows the step-up sheet, answers a fresh `security:challenge` with a
//! security key, a passkey or a code, sends it with `security:confirm`, and
//! calls again: one confirmation covers that action class on that surface
//! (the desktop window or the Local Web UI) for `coverMs`, five minutes.
//! Turning step-up off and removing a method are not covered: each carries
//! its own proof, from a *different* method or a recovery code.
//!
//! Registration: `navigator.credentials.create()` in a browser only accepts
//! a domain as the relying-party id, so a credential registered from a page
//! is bound to that page's host (`localhost` for the desktop's ceremony
//! window and a Local Web UI opened on this computer) and records it as its
//! own `rpId`; `security.json`'s `rpId` (the computer's id) stays for the
//! phones. A loopback page's port changes from launch to launch, so a
//! `localhost` credential is accepted from any `http://localhost` origin
//! rather than from a list.
//!
//! Nothing here is phone-callable: the phone gate answers `security:challenge`
//! itself and refuses every other `security:` channel (not in `PHONE_CHANNELS`).

use nekko_remote::step_up::{self, Issued, SecurityStore};
use nekko_remote::step_up_register;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The channels served here.
pub const CHANNELS: &[&str] = &[
    "security:status",
    "security:challenge",
    "security:confirm",
    "security:registerBegin",
    "security:registerKey",
    "security:totpBegin",
    "security:totpConfirm",
    "security:enable",
    "security:disable",
    "security:removeMethod",
    "security:recoveryCodes",
];

/// Adding a method or new recovery codes while step-up is on needs a step-up
/// too, or anyone at the keyboard could register their own key and answer
/// with it. Not in `STEP_UP_DESKTOP_GUARDED` (shared/step-up.ts keeps its
/// list); the TS twin is `STEP_UP_DESKTOP_METHODS` in step-up-desktop.ts.
pub const METHODS_ACTION: &str = "securityMethods";
pub const METHODS_CHANNELS: &[&str] = &[
    "security:registerBegin",
    "security:registerKey",
    "security:totpBegin",
    "security:totpConfirm",
    "security:recoveryCodes",
];

/// Action classes that carry their own proof, or that the desktop does not
/// guard here: `stepUpOff` (a different method or a recovery code, checked by
/// `security:disable` and `security:removeMethod`) and `modeRaise` (the
/// phone's; the desktop's mode switch is not on SK-4's list).
const NOT_COVERED: &[&str] = &["stepUpOff", "modeRaise"];

/// The plain sentence for each refusal (`STEP_UP_MESSAGES`).
fn sentence(code: &str) -> &'static str {
    match code {
        "step-up-required" => "Confirm with your security key or a code to do this.",
        "step-up-stale" => "That confirmation took too long. Try again.",
        "step-up-replayed" => "That confirmation was already used. Try again.",
        _ => "That key or code was not accepted. Try again.",
    }
}

/// A refusal the page reads: `Step-up needed (code) [action]: sentence`.
pub fn refusal(code: &str, action: &str, why: Option<&str>) -> String {
    let text = match why {
        Some("locked") => "Too many wrong codes. Wait a minute, then try again.",
        Some("counter") => {
            "That key’s counter went backwards, so it may have been copied. It is marked possibly cloned in Settings → Security."
        }
        _ => sentence(code),
    };
    format!("Step-up needed ({code}) [{action}]: {text}")
}

/// Which surface a call came in on: one confirmation covers that surface only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    /// The desktop window's socket (`/api/ws`).
    Desktop,
    /// `POST /api/{channel}`: the Local Web UI (and the CLI).
    Web,
}

impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Surface::Desktop => "desktop",
            Surface::Web => "web",
        }
    }
}

type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// A one-time-code secret shown but not yet confirmed.
struct PendingTotp {
    secret: String,
    at: f64,
    tries: u32,
}

#[derive(Default)]
struct Books {
    /// Step-up challenges per surface (single use, two minutes).
    challenges: HashMap<&'static str, Vec<Issued>>,
    /// Registration challenges per surface.
    registrations: HashMap<&'static str, Vec<Issued>>,
    /// When each (surface, action class) was last confirmed.
    covered: HashMap<(&'static str, String), f64>,
    pending_totp: HashMap<&'static str, PendingTotp>,
}

pub struct Security {
    store: Option<Arc<dyn SecurityStore>>,
    clock: Clock,
    books: Mutex<Books>,
}

/// A pending one-time-code secret lasts this long.
const PENDING_TOTP_MS: f64 = 10.0 * 60.0 * 1000.0;
/// Wrong confirmations of a pending secret before it is dropped.
const PENDING_TOTP_TRIES: u32 = 10;
/// The longest name a method keeps.
const NAME_MAX: usize = 60;

fn limits() -> &'static step_up::Limits {
    &nekko_remote::phone::policy().step_up
}

fn num(n: f64) -> Value {
    nekko_remote::hello::nekko_num(n)
}

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn methods(state: &Value) -> usize {
    let keys = state.get("credentials").and_then(Value::as_array).map_or(0, Vec::len);
    keys + usize::from(state.get("totp").is_some_and(Value::is_object))
}

fn list<'a>(state: &'a Value, key: &str) -> &'a [Value] {
    state.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn obj(state: &mut Value) -> &mut Map<String, Value> {
    if !state.is_object() {
        *state = json!({});
    }
    state.as_object_mut().expect("just made an object")
}

/// Whether `origin` is a page on this computer over http (`http://localhost:<port>`).
fn loopback_origin(origin: &str) -> bool {
    origin.starts_with("http://") && step_up_register::origin_host(origin) == Some("localhost")
}

/// The action class a desktop channel belongs to, if it is guarded here.
pub fn action_of(channel: &str) -> Option<String> {
    if METHODS_CHANNELS.contains(&channel) {
        return Some(METHODS_ACTION.to_string());
    }
    limits()
        .desktop_guarded
        .iter()
        .find(|(action, list)| !NOT_COVERED.contains(&action.as_str()) && list.iter().any(|c| c == channel))
        .map(|(action, _)| action.clone())
}

/// Every action class a confirmation can cover.
fn coverable(action: &str) -> bool {
    action == METHODS_ACTION
        || limits().desktop_guarded.iter().any(|(a, _)| a == action && !NOT_COVERED.contains(&a.as_str()))
}

/// What a proof turned out to be, for the page ("Confirmed with YubiKey").
struct Answered {
    method: &'static str,
    name: String,
    credential: Option<String>,
}

impl Security {
    pub fn new(store: Option<Arc<dyn SecurityStore>>, clock: Clock) -> Self {
        Self { store, clock, books: Mutex::default() }
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Books> {
        self.books.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn store(&self) -> Result<&Arc<dyn SecurityStore>, String> {
        self.store.as_ref().ok_or_else(|| "Security needs this computer’s data folder.".to_string())
    }

    /// `security.json`, or a fresh one (step-up off, no method) to write.
    fn load_or_new(&self) -> Result<Value, String> {
        Ok(self.store()?.load().unwrap_or_else(fresh_state))
    }

    fn save(&self, state: &Value) -> Result<(), String> {
        self.store()?.save(state).map_err(|e| format!("Couldn’t save security.json: {e}"))
    }

    /// The check before a guarded call from `surface`: nothing when step-up
    /// is off or the action class was confirmed in the last `coverMs`,
    /// `step-up-required` otherwise.
    pub fn guard(&self, surface: Surface, channel: &str) -> Result<(), String> {
        let Some(action) = action_of(channel) else { return Ok(()) };
        let Some(store) = &self.store else { return Ok(()) };
        let Some(state) = store.load() else { return Ok(()) };
        if !step_up::enabled(&state) {
            return Ok(());
        }
        let now = self.now();
        let books = self.lock();
        let fresh =
            books.covered.get(&(surface.as_str(), action.clone())).is_some_and(|at| now - at < limits().cover_ms);
        if fresh { Ok(()) } else { Err(refusal("step-up-required", &action, None)) }
    }

    pub fn route(&self, surface: Surface, channel: &str, args: &[Value]) -> Result<Value, String> {
        match channel {
            "security:status" => Ok(self.status(surface)),
            "security:challenge" => self.challenge(surface),
            "security:confirm" => self.confirm(surface, arg(args, 0).as_str().unwrap_or_default(), arg(args, 1)),
            "security:registerBegin" => self.register_begin(surface, arg(args, 0).as_str()),
            "security:registerKey" => self.register_key(surface, arg(args, 0)),
            "security:totpBegin" => self.totp_begin(surface),
            "security:totpConfirm" => self.totp_confirm(surface, arg(args, 0), arg(args, 1).as_str()),
            "security:enable" => self.enable(surface),
            "security:disable" => self.disable(surface, arg(args, 0)),
            "security:removeMethod" => self.remove(surface, arg(args, 0).as_str().unwrap_or_default(), arg(args, 1)),
            "security:recoveryCodes" => self.recovery_codes(),
            _ => Err(format!("unknown channel {channel}")),
        }
    }

    /// Settings → Security: the methods by name (never a secret or a public
    /// key), whether step-up is on, and what this surface has confirmed.
    pub fn status(&self, surface: Surface) -> Value {
        let state = self.store.as_ref().and_then(|s| s.load());
        let now = self.now();
        let covered: Map<String, Value> = self
            .lock()
            .covered
            .iter()
            .filter(|((s, _), at)| *s == surface.as_str() && now - **at < limits().cover_ms)
            .map(|((_, action), at)| (action.clone(), num(at + limits().cover_ms)))
            .collect();
        let Some(state) = state else {
            return json!({
                "available": self.store.is_some(), "enabled": false, "methods": [], "totp": null,
                "recoveryLeft": 0, "minMethods": limits().min_methods, "coverMs": num(limits().cover_ms),
                "covered": covered,
            });
        };
        let credentials: Vec<Value> = list(&state, "credentials")
            .iter()
            .map(|c| {
                json!({
                    "id": c.get("id"), "name": c.get("name"), "kind": c.get("kind"), "addedAt": c.get("addedAt"),
                    "lastUsedAt": c.get("lastUsedAt"), "cloned": c.get("cloned").and_then(Value::as_bool).unwrap_or(false),
                })
            })
            .collect();
        let totp = state.get("totp").filter(|t| t.is_object()).map(|t| {
            let locked = t.get("lockedUntil").and_then(Value::as_f64).filter(|u| *u > now);
            json!({ "addedAt": t.get("addedAt"), "lastUsedAt": t.get("lastUsedAt"), "lockedUntil": locked.map(num) })
        });
        json!({
            "available": true,
            "enabled": step_up::enabled(&state),
            // A file that can't be read counts as on with no method: say so.
            "damaged": state.get("version").is_none(),
            "methods": credentials,
            "totp": totp,
            "recoveryLeft": list(&state, "recoveryHashes").len(),
            "minMethods": limits().min_methods,
            "coverMs": num(limits().cover_ms),
            "covered": covered,
        })
    }

    /// A fresh single-use challenge for the step-up sheet, and the methods it
    /// can offer: by name here, unlike a phone's, since this is the computer.
    fn challenge(&self, surface: Surface) -> Result<Value, String> {
        let state = self.store.as_ref().and_then(|s| s.load()).unwrap_or(Value::Null);
        let now = self.now();
        let challenge = step_up::new_challenge(limits().challenge_bytes);
        let mut books = self.lock();
        push_issued(books.challenges.entry(surface.as_str()).or_default(), &challenge, now);
        let credentials: Vec<Value> = list(&state, "credentials")
            .iter()
            .map(|c| json!({ "id": c.get("id"), "name": c.get("name"), "kind": c.get("kind"), "rpId": c.get("rpId") }))
            .collect();
        Ok(json!({
            "challenge": challenge,
            "expiresAt": num(now + limits().challenge_ttl_ms),
            "required": step_up::enabled(&state),
            "methods": step_up::method_kinds(&state),
            "credentials": credentials,
            "totp": state.get("totp").is_some_and(Value::is_object),
            "recovery": !list(&state, "recoveryHashes").is_empty(),
        }))
    }

    /// Check a proof against `state` (updated in place): a FIDO2 assertion or
    /// a code, or (`recovery_ok`) a recovery code. `not` names a method the
    /// proof may not come from (the one being removed).
    fn verify(
        &self,
        books: &mut Books,
        surface: Surface,
        state: &mut Value,
        proof: &Value,
        recovery_ok: bool,
        not: Option<&str>,
    ) -> Result<Answered, (&'static str, Option<&'static str>)> {
        if let Some(code) = proof.get("recovery").and_then(Value::as_str) {
            if !recovery_ok {
                return Err(("step-up-invalid", None));
            }
            return if step_up::use_recovery_code(state, code) {
                Ok(Answered { method: "recovery", name: "a recovery code".into(), credential: None })
            } else {
                Err(("step-up-invalid", None))
            };
        }
        let is_totp = proof.get("totp").is_some();
        let credential = proof.get("credentialId").and_then(Value::as_str).map(String::from);
        let same = match (not, is_totp, &credential) {
            (Some("totp"), true, _) => true,
            (Some(id), false, Some(c)) => {
                step_up::from_b64url(id).is_some() && step_up::from_b64url(id) == step_up::from_b64url(c)
            }
            _ => false,
        };
        if same {
            return Err(("step-up-invalid", Some("same method")));
        }
        // A localhost credential answers from whichever port the page is on.
        let origins_before = state.get("origins").cloned();
        if let Some(origin) = loopback_answer(state, proof) {
            let o = obj(state).entry("origins").or_insert_with(|| json!([]));
            if let Some(a) = o.as_array_mut() {
                a.push(json!(origin));
            }
        }
        let book = books.challenges.entry(surface.as_str()).or_default();
        let out = step_up::check(state, book, self.now(), Some(proof));
        match origins_before {
            Some(o) => {
                obj(state).insert("origins".into(), o);
            }
            None => {
                obj(state).remove("origins");
            }
        }
        if !out.ok() {
            return Err((out.result, out.why));
        }
        let name = match &credential {
            Some(id) => list(state, "credentials")
                .iter()
                .find(|c| c.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .and_then(|c| c.get("name").and_then(Value::as_str))
                .unwrap_or("your security key")
                .to_string(),
            None => "a one-time code".into(),
        };
        Ok(Answered { method: out.method.unwrap_or("fido2"), name, credential })
    }

    /// `security:confirm(action, proof)`: answer the step-up sheet. Covers
    /// `action` on this surface for `coverMs` and says which method answered.
    fn confirm(&self, surface: Surface, action: &str, proof: &Value) -> Result<Value, String> {
        if !coverable(action) {
            return Err(format!("security:confirm: {action} is not a guarded action"));
        }
        let mut state = self.load_or_new()?;
        let now = self.now();
        if !step_up::enabled(&state) {
            return Ok(json!({ "ok": true, "required": false }));
        }
        let mut books = self.lock();
        let out = self.verify(&mut books, surface, &mut state, proof, false, None);
        // The counter, the TOTP rate limit and the cloned flag are kept whatever happened.
        self.save(&state).map_err(|_| refusal("step-up-invalid", action, None))?;
        let answered = out.map_err(|(code, why)| refusal(code, action, why))?;
        books.covered.insert((surface.as_str(), action.to_string()), now);
        Ok(json!({
            "ok": true,
            "required": true,
            "method": answered.method,
            "name": answered.name,
            "credentialId": answered.credential,
            "coveredUntil": num(now + limits().cover_ms),
        }))
    }

    /// `security:registerBegin(kind)`: what `navigator.credentials.create()`
    /// needs from the computer. The page fills in `rp.id` (its own host).
    fn register_begin(&self, surface: Surface, kind: Option<&str>) -> Result<Value, String> {
        let kind = match kind {
            Some("passkey") => "passkey",
            _ => "security-key",
        };
        let state = self.load_or_new()?;
        let now = self.now();
        let challenge = step_up::new_challenge(limits().challenge_bytes);
        push_issued(self.lock().registrations.entry(surface.as_str()).or_default(), &challenge, now);
        let rp = state.get("rpId").and_then(Value::as_str).unwrap_or_default();
        let host = gethostname::gethostname().to_string_lossy().into_owned();
        let exclude: Vec<Value> = list(&state, "credentials").iter().map(|c| json!({ "id": c.get("id") })).collect();
        Ok(json!({
            "challenge": challenge,
            "rpName": "Nekko Agent",
            // Stable per computer, so a key replaces rather than piles up its own credentials.
            "userId": step_up::to_b64url(&sha256(rp.as_bytes())[..16]),
            "userName": format!("nekko-agent@{host}"),
            "userDisplayName": format!("Nekko Agent on {host}"),
            "kind": kind,
            "attachment": if kind == "passkey" { "platform" } else { "cross-platform" },
            "excludeCredentials": exclude,
            "timeoutMs": num(limits().challenge_ttl_ms),
        }))
    }

    /// `security:registerKey({ name, kind, rpId, id, clientDataJSON, attestationObject })`.
    fn register_key(&self, surface: Surface, input: &Value) -> Result<Value, String> {
        let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or_default();
        let kind = if s("kind") == "passkey" { "passkey" } else { "security-key" };
        let rp_id = s("rpId").to_ascii_lowercase();
        let mut state = self.load_or_new()?;
        let now = self.now();
        let answer = step_up_register::Answer {
            id: s("id"),
            client_data_json: s("clientDataJSON"),
            attestation_object: s("attestationObject"),
        };
        let book_out = {
            let mut books = self.lock();
            let book = books.registrations.entry(surface.as_str()).or_default();
            step_up_register::verify(book, now, limits().challenge_ttl_ms, &rp_id, &answer)
        };
        let reg = book_out.map_err(|why| match why {
            "stale" => "That took too long. Try again.".to_string(),
            "replayed" | "challenge" => "That registration was already used. Try again.".to_string(),
            "algorithm" | "key type" | "curve" => {
                "That key offered a kind of signature Nekko Agent doesn’t check (only ES256). Try another key."
                    .to_string()
            }
            other => format!("That key could not be registered ({other})."),
        })?;
        let known = list(&state, "credentials").iter().any(|c| {
            c.get("id").and_then(Value::as_str).and_then(step_up::from_b64url) == step_up::from_b64url(&reg.id)
        });
        if known {
            return Err("That key is already registered on this computer.".into());
        }
        let first = methods(&state) == 0;
        let fallback = if kind == "passkey" { "Passkey" } else { "Security key" };
        let name = clean_name(s("name"), fallback);
        let credential = json!({
            "id": reg.id, "publicKey": reg.public_key, "counter": reg.counter, "name": name, "kind": kind,
            "addedAt": num(now), "rpId": rp_id,
        });
        let root = obj(&mut state);
        root.entry("credentials")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("security.json: credentials")?
            .push(credential);
        if !loopback_origin(&reg.origin) {
            let origins = root.entry("origins").or_insert_with(|| json!([]));
            if let Some(a) = origins.as_array_mut()
                && !a.iter().any(|o| o.as_str() == Some(reg.origin.as_str()))
            {
                a.push(json!(reg.origin));
            }
        }
        let codes = first_codes(&mut state, first);
        self.save(&state)?;
        Ok(json!({ "status": self.status(surface), "recoveryCodes": codes, "name": name }))
    }

    /// `security:totpBegin`: a new secret, shown once as a QR. Saved only once
    /// a code from it is confirmed.
    fn totp_begin(&self, surface: Surface) -> Result<Value, String> {
        let state = self.load_or_new()?;
        if state.get("totp").is_some_and(Value::is_object) {
            return Err("A one-time code app is already set up. Remove it first to set up another.".into());
        }
        let secret = step_up::new_totp_secret();
        let host = gethostname::gethostname().to_string_lossy().into_owned();
        let l = limits();
        let uri = format!(
            "otpauth://totp/Nekko%20Agent:{}?secret={secret}&issuer=Nekko%20Agent&algorithm=SHA1&digits={}&period={}",
            percent(&host),
            l.totp_digits,
            l.totp_period_s
        );
        self.lock()
            .pending_totp
            .insert(surface.as_str(), PendingTotp { secret: secret.clone(), at: self.now(), tries: 0 });
        Ok(json!({ "secret": secret, "uri": uri, "account": host }))
    }

    /// `security:totpConfirm(code)`: the first code from the app, proving it holds the secret.
    fn totp_confirm(&self, surface: Surface, code: &Value, _name: Option<&str>) -> Result<Value, String> {
        let now = self.now();
        let l = limits();
        let secret = {
            let mut books = self.lock();
            let Some(p) = books.pending_totp.get_mut(surface.as_str()) else {
                return Err("Start again: show a new QR code.".into());
            };
            if now - p.at > PENDING_TOTP_MS || p.tries >= PENDING_TOTP_TRIES {
                books.pending_totp.remove(surface.as_str());
                return Err("That QR code has expired. Show a new one.".into());
            }
            p.tries += 1;
            p.secret.clone()
        };
        let bytes = step_up::base32_decode(&secret).ok_or("That QR code has expired. Show a new one.")?;
        let code =
            code.as_str().map(|c| c.chars().filter(char::is_ascii_digit).collect::<String>()).unwrap_or_default();
        let step = step_up::totp_step(now, l.totp_period_s);
        let matched = (-l.totp_window..=l.totp_window)
            .map(|d| step + d)
            .find(|s| code.len() == l.totp_digits as usize && step_up::totp_at(&bytes, *s, l.totp_digits) == code);
        let Some(matched) = matched else {
            return Err(
                "That code didn’t match. Check the clock on the device with the app, then try the next code.".into()
            );
        };
        let mut state = self.load_or_new()?;
        if state.get("totp").is_some_and(Value::is_object) {
            return Err("A one-time code app is already set up.".into());
        }
        let first = methods(&state) == 0;
        obj(&mut state)
            .insert("totp".into(), json!({ "secret": secret, "addedAt": num(now), "lastStep": num(matched as f64) }));
        let codes = first_codes(&mut state, first);
        self.save(&state)?;
        self.lock().pending_totp.remove(surface.as_str());
        Ok(json!({ "status": self.status(surface), "recoveryCodes": codes }))
    }

    /// `security:enable`: only with at least `minMethods` registered.
    fn enable(&self, surface: Surface) -> Result<Value, String> {
        let mut state = self.load_or_new()?;
        let min = limits().min_methods.max(2);
        if methods(&state) < min {
            return Err(format!(
                "Register at least {min} methods first (two keys, or a key and a one-time code app), so a lost key never locks you out."
            ));
        }
        obj(&mut state).insert("enabled".into(), json!(true));
        self.save(&state)?;
        Ok(self.status(surface))
    }

    /// `security:disable(proof)`: any registered method, or a recovery code.
    fn disable(&self, surface: Surface, proof: &Value) -> Result<Value, String> {
        let mut state = self.load_or_new()?;
        if !step_up::enabled(&state) {
            return Ok(self.status(surface));
        }
        let mut books = self.lock();
        let out = self.verify(&mut books, surface, &mut state, proof, true, None);
        if let Err((code, why)) = out {
            let _ = self.save(&state);
            return Err(refusal(code, "stepUpOff", why));
        }
        obj(&mut state).insert("enabled".into(), json!(false));
        self.save(&state)?;
        books.covered.clear();
        drop(books);
        Ok(self.status(surface))
    }

    /// `security:removeMethod(id | "totp", proof)`: with step-up on, a proof
    /// from a different method or a recovery code, and never below the minimum.
    fn remove(&self, surface: Surface, id: &str, proof: &Value) -> Result<Value, String> {
        let mut state = self.load_or_new()?;
        let is_totp = id == "totp";
        let exists = if is_totp {
            state.get("totp").is_some_and(Value::is_object)
        } else {
            list(&state, "credentials").iter().any(|c| c.get("id").and_then(Value::as_str) == Some(id))
        };
        if !exists {
            return Err("That method is not registered on this computer.".into());
        }
        let mut books = self.lock();
        if step_up::enabled(&state) {
            let min = limits().min_methods.max(2);
            if methods(&state) <= min {
                return Err(format!(
                    "Step-up needs {min} methods. Add another one first, or turn step-up off, then remove this one."
                ));
            }
            if let Err((code, why)) = self.verify(&mut books, surface, &mut state, proof, true, Some(id)) {
                let _ = self.save(&state);
                let detail = if why == Some("same method") {
                    "Step-up needed (step-up-invalid) [stepUpOff]: Confirm with a different method than the one you are removing, or a recovery code.".to_string()
                } else {
                    refusal(code, "stepUpOff", why)
                };
                return Err(detail);
            }
        }
        drop(books);
        let root = obj(&mut state);
        if is_totp {
            root.insert("totp".into(), Value::Null);
        } else if let Some(a) = root.get_mut("credentials").and_then(Value::as_array_mut) {
            a.retain(|c| c.get("id").and_then(Value::as_str) != Some(id));
        }
        self.save(&state)?;
        Ok(self.status(surface))
    }

    /// `security:recoveryCodes`: ten new codes, shown once; the old ones stop working.
    fn recovery_codes(&self) -> Result<Value, String> {
        let mut state = self.load_or_new()?;
        if methods(&state) == 0 {
            return Err("Register a security key or a one-time code app first.".into());
        }
        let codes = first_codes(&mut state, true).unwrap_or_default();
        self.save(&state)?;
        Ok(json!(codes))
    }
}

/// A new `security.json`: step-up off, no method, a relying-party id of its own.
fn fresh_state() -> Value {
    let mut id = [0u8; 12];
    getrandom::fill(&mut id).expect("the OS random source is available");
    json!({
        "version": 1,
        "enabled": false,
        "rpId": format!("nekko-computer:{}", step_up::to_b64url(&id)),
        "origins": [],
        "credentials": [],
        "totp": null,
        "recoveryHashes": [],
    })
}

/// When `make` (the first method, or asked for), ten new recovery codes:
/// their hashes replace the old ones, and the codes go to the page once.
fn first_codes(state: &mut Value, make: bool) -> Option<Vec<String>> {
    if !make {
        return None;
    }
    let l = limits();
    let codes = step_up::new_recovery_codes(l.recovery_count.max(1), l.recovery_length.max(8));
    let hashes: Vec<Value> = codes.iter().map(|c| json!(step_up::hash_recovery_code(c))).collect();
    obj(state).insert("recoveryHashes".into(), Value::Array(hashes));
    Some(codes)
}

fn push_issued(list: &mut Vec<Issued>, challenge: &str, now: f64) {
    // Keep a spent or expired one a while, so a late or repeated answer is named.
    list.retain(|x| now - x.issued_at <= 2.0 * limits().challenge_ttl_ms);
    if list.len() >= 16 {
        list.remove(0);
    }
    list.push(Issued { challenge: challenge.to_string(), issued_at: now, used: false });
}

/// The origin of a FIDO2 answer from a `localhost` credential on a loopback page.
fn loopback_answer(state: &Value, proof: &Value) -> Option<String> {
    let id = step_up::from_b64url(proof.get("credentialId")?.as_str()?)?;
    let cred = list(state, "credentials")
        .iter()
        .find(|c| c.get("id").and_then(Value::as_str).and_then(step_up::from_b64url).as_deref() == Some(&id[..]))?;
    if cred.get("rpId").and_then(Value::as_str) != Some("localhost") {
        return None;
    }
    let cdj = step_up::from_b64url(proof.get("clientDataJSON")?.as_str()?)?;
    let client: Value = serde_json::from_slice(&cdj).ok()?;
    let origin = client.get("origin")?.as_str()?;
    loopback_origin(origin).then(|| origin.to_string())
}

fn clean_name(name: &str, fallback: &str) -> String {
    let name: String =
        name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(NAME_MAX).collect();
    if name.is_empty() { fallback.to_string() } else { name }
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).to_vec()
}

fn percent(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{DerSignature, SigningKey};
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct Mem(Mutex<Option<Value>>);
    impl SecurityStore for Mem {
        fn load(&self) -> Option<Value> {
            self.0.lock().unwrap().clone()
        }
        fn save(&self, state: &Value) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(state.clone());
            Ok(())
        }
    }

    const T0: u64 = 1_790_000_000_000;

    struct Rig {
        sec: Security,
        mem: Arc<Mem>,
        clock: Arc<AtomicU64>,
    }

    fn rig() -> Rig {
        let mem = Arc::new(Mem::default());
        let clock = Arc::new(AtomicU64::new(T0));
        let c = clock.clone();
        let sec = Security::new(
            Some(mem.clone() as Arc<dyn SecurityStore>),
            Arc::new(move || c.load(Ordering::SeqCst) as f64),
        );
        Rig { sec, mem, clock }
    }

    impl Rig {
        fn call(&self, surface: Surface, channel: &str, args: Value) -> Result<Value, String> {
            self.sec.route(surface, channel, args.as_array().unwrap())
        }
        fn d(&self, channel: &str, args: Value) -> Result<Value, String> {
            self.call(Surface::Desktop, channel, args)
        }
        fn advance(&self, ms: u64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }
        fn now(&self) -> f64 {
            self.clock.load(Ordering::SeqCst) as f64
        }

        /// Register a software authenticator from a loopback page.
        fn register(&self, key: &SigningKey, id: u8, origin: &str) -> Value {
            let begin = self.d("security:registerBegin", json!(["security-key"])).unwrap();
            let challenge = begin["challenge"].as_str().unwrap();
            let (cid, cdj, att) = registration(key, challenge, id, origin);
            self.d(
                "security:registerKey",
                json!([{ "name": format!("Key {id}"), "kind": "security-key", "rpId": "localhost",
                    "id": cid, "clientDataJSON": cdj, "attestationObject": att }]),
            )
            .unwrap()
        }

        /// A software authenticator's answer to a fresh challenge.
        fn assert(&self, surface: Surface, key: &SigningKey, id: u8, counter: u32, origin: &str) -> Value {
            let c = self.call(surface, "security:challenge", json!([])).unwrap();
            let challenge = c["challenge"].as_str().unwrap();
            let mut auth = sha256(b"localhost");
            auth.push(0x05);
            auth.extend(counter.to_be_bytes());
            let cdj = json!({ "type": "webauthn.get", "challenge": challenge, "origin": origin }).to_string();
            let mut signed = auth.clone();
            signed.extend(sha256(cdj.as_bytes()));
            let sig: DerSignature = key.sign(&signed);
            json!({ "credentialId": step_up::to_b64url(&[id; 16]), "authenticatorData": step_up::to_b64url(&auth),
                "clientDataJSON": step_up::to_b64url(cdj.as_bytes()), "signature": step_up::to_b64url(sig.as_bytes()) })
        }

        fn totp(&self) -> String {
            let secret = self.mem.load().unwrap()["totp"]["secret"].as_str().unwrap().to_string();
            let step = step_up::totp_step(self.now(), 30.0);
            step_up::totp_at(&step_up::base32_decode(&secret).unwrap(), step, 6)
        }

        fn add_totp(&self) -> Value {
            let begin = self.d("security:totpBegin", json!([])).unwrap();
            assert!(begin["uri"].as_str().unwrap().starts_with("otpauth://totp/Nekko%20Agent:"));
            let secret = step_up::base32_decode(begin["secret"].as_str().unwrap()).unwrap();
            let code = step_up::totp_at(&secret, step_up::totp_step(self.now(), 30.0), 6);
            self.d("security:totpConfirm", json!([code])).unwrap()
        }
    }

    /// `(id, clientDataJSON, attestationObject)` of a software authenticator's registration.
    fn registration(key: &SigningKey, challenge: &str, id: u8, origin: &str) -> (String, String, String) {
        use step_up_register::{Cbor, cose_es256_key, encode};
        let point = key.verifying_key().to_encoded_point(false);
        let mut auth = sha256(b"localhost");
        auth.push(0x45); // user present, verified, attested credential data
        auth.extend(0u32.to_be_bytes());
        auth.extend([0u8; 16]);
        auth.extend(16u16.to_be_bytes());
        auth.extend([id; 16]);
        auth.extend(encode(&cose_es256_key(point.x().unwrap(), point.y().unwrap())));
        let object = Cbor::Map(vec![
            (Cbor::Text("fmt".into()), Cbor::Text("none".into())),
            (Cbor::Text("attStmt".into()), Cbor::Map(vec![])),
            (Cbor::Text("authData".into()), Cbor::Bytes(auth)),
        ]);
        let cdj = json!({ "type": "webauthn.create", "challenge": challenge, "origin": origin }).to_string();
        (step_up::to_b64url(&[id; 16]), step_up::to_b64url(cdj.as_bytes()), step_up::to_b64url(&encode(&object)))
    }

    fn key(n: u8) -> SigningKey {
        SigningKey::from_slice(&[n; 32]).unwrap()
    }

    const PAGE: &str = "http://localhost:49152";

    #[test]
    fn nothing_is_guarded_until_step_up_is_on() {
        let r = rig();
        assert_eq!(r.sec.guard(Surface::Desktop, "remote:enable"), Ok(()));
        assert_eq!(r.d("security:status", json!([])).unwrap()["enabled"], false);
        r.register(&key(1), 1, PAGE);
        assert_eq!(r.sec.guard(Surface::Desktop, "remote:pair"), Ok(()));
    }

    #[test]
    fn the_first_method_brings_ten_recovery_codes_once() {
        let r = rig();
        let first = r.register(&key(1), 1, PAGE);
        let codes = first["recoveryCodes"].as_array().unwrap();
        assert_eq!(codes.len(), 10);
        assert_eq!(first["status"]["recoveryLeft"], 10);
        let saved = r.mem.load().unwrap();
        assert_eq!(saved["credentials"][0]["rpId"], "localhost");
        assert_eq!(saved["origins"], json!([]), "a loopback page's port is not kept");
        assert!(saved["rpId"].as_str().unwrap().starts_with("nekko-computer:"));
        assert!(!saved.to_string().contains(codes[0].as_str().unwrap()), "only hashes are kept");
        let second = r.add_totp();
        assert!(second["recoveryCodes"].is_null(), "shown once, with the first method");
    }

    #[test]
    fn two_methods_before_it_can_be_turned_on() {
        let r = rig();
        r.register(&key(1), 1, PAGE);
        let err = r.d("security:enable", json!([])).unwrap_err();
        assert!(err.contains("at least 2 methods"), "{err}");
        r.add_totp();
        assert_eq!(r.d("security:enable", json!([])).unwrap()["enabled"], true);
    }

    fn on() -> Rig {
        let r = rig();
        r.register(&key(1), 1, PAGE);
        r.register(&key(2), 2, PAGE);
        r.add_totp();
        r.d("security:enable", json!([])).unwrap();
        r
    }

    #[test]
    fn a_guarded_call_needs_a_confirmation_that_covers_five_minutes_on_that_surface() {
        let r = on();
        let err = r.sec.guard(Surface::Desktop, "remote:enable").unwrap_err();
        assert_eq!(
            err,
            "Step-up needed (step-up-required) [remoteAccess]: Confirm with your security key or a code to do this."
        );
        assert_eq!(r.sec.guard(Surface::Desktop, "settings:get"), Ok(()));
        // A different port from the one it registered on: still this computer's page.
        let a = r.assert(Surface::Desktop, &key(1), 1, 1, "http://localhost:60001");
        let ok = r.d("security:confirm", json!(["remoteAccess", a])).unwrap();
        assert_eq!(ok["name"], "Key 1", "the sheet names the key that answered");
        assert_eq!(r.sec.guard(Surface::Desktop, "remote:enable"), Ok(()));
        assert_eq!(r.sec.guard(Surface::Desktop, "remote:attach"), Ok(()), "the same class");
        assert!(r.sec.guard(Surface::Desktop, "remote:pair").is_err(), "another class");
        assert!(r.sec.guard(Surface::Web, "remote:enable").is_err(), "another surface");
        assert_eq!(
            r.d("security:status", json!([])).unwrap()["covered"]["remoteAccess"].as_f64(),
            Some(r.now() + 300_000.0)
        );
        r.advance(300_000);
        assert!(r.sec.guard(Surface::Desktop, "remote:enable").is_err(), "five minutes, then ask again");
    }

    #[test]
    fn replayed_stale_and_foreign_answers_are_refused() {
        let r = on();
        let a = r.assert(Surface::Desktop, &key(1), 1, 1, PAGE);
        r.d("security:confirm", json!(["pairing", a.clone()])).unwrap();
        let err = r.d("security:confirm", json!(["pairing", a])).unwrap_err();
        assert!(err.starts_with("Step-up needed (step-up-replayed) [pairing]"), "{err}");
        let late = r.assert(Surface::Desktop, &key(1), 1, 2, PAGE);
        r.advance(120_001);
        assert!(r.d("security:confirm", json!(["pairing", late])).unwrap_err().contains("(step-up-stale)"));
        let evil = r.assert(Surface::Desktop, &key(1), 1, 3, "https://evil.example");
        assert!(r.d("security:confirm", json!(["pairing", evil])).unwrap_err().contains("(step-up-invalid)"));
        // A Local Web UI challenge is not the desktop's.
        let web = r.assert(Surface::Web, &key(1), 1, 4, PAGE);
        assert!(r.d("security:confirm", json!(["pairing", web])).unwrap_err().contains("(step-up-invalid)"));
        assert!(r.d("security:confirm", json!(["nonsense", {}])).is_err());
    }

    #[test]
    fn a_counter_that_does_not_rise_marks_the_key_possibly_cloned() {
        let r = on();
        let a = r.assert(Surface::Desktop, &key(1), 1, 5, PAGE);
        r.d("security:confirm", json!(["providerKeys", a])).unwrap();
        let b = r.assert(Surface::Desktop, &key(1), 1, 5, PAGE);
        let err = r.d("security:confirm", json!(["providerKeys", b])).unwrap_err();
        assert!(err.contains("possibly cloned"), "{err}");
        let status = r.d("security:status", json!([])).unwrap();
        assert_eq!(status["methods"][0]["cloned"], true);
        assert_eq!(status["methods"][1]["cloned"], false);
    }

    #[test]
    fn a_code_answers_and_wrong_codes_lock() {
        let r = on();
        // The code that set the app up is spent: the next step's.
        r.advance(30_000);
        let code = r.totp();
        let ok = r.d("security:confirm", json!(["phoneAccess", { "totp": code }])).unwrap();
        assert_eq!(ok["method"], "totp");
        for _ in 0..5 {
            let _ = r.d("security:confirm", json!(["phoneAccess", { "totp": "000000" }]));
        }
        r.advance(30_000);
        let err = r.d("security:confirm", json!(["phoneAccess", { "totp": r.totp() }])).unwrap_err();
        assert!(err.contains("Too many wrong codes"), "{err}");
        assert!(r.d("security:status", json!([])).unwrap()["totp"]["lockedUntil"].is_number());
    }

    #[test]
    fn adding_a_method_while_on_needs_a_step_up() {
        let r = on();
        assert!(r.sec.guard(Surface::Desktop, "security:registerKey").unwrap_err().contains("[securityMethods]"));
        assert!(r.sec.guard(Surface::Desktop, "security:totpBegin").is_err());
        assert_eq!(r.sec.guard(Surface::Desktop, "security:status"), Ok(()));
        assert_eq!(r.sec.guard(Surface::Desktop, "security:challenge"), Ok(()));
        assert_eq!(r.sec.guard(Surface::Desktop, "security:confirm"), Ok(()));
    }

    #[test]
    fn turning_off_takes_any_method_or_a_recovery_code_once() {
        let r = rig();
        let codes = r.register(&key(1), 1, PAGE)["recoveryCodes"].clone();
        r.add_totp();
        r.d("security:enable", json!([])).unwrap();
        assert!(r.d("security:disable", json!([null])).unwrap_err().contains("(step-up-required)"));
        let code = codes[0].as_str().unwrap();
        assert_eq!(r.d("security:disable", json!([{ "recovery": code }])).unwrap()["enabled"], false);
        assert_eq!(r.d("security:status", json!([])).unwrap()["recoveryLeft"], 9);
        r.d("security:enable", json!([])).unwrap();
        assert!(r.d("security:disable", json!([{ "recovery": code }])).is_err(), "each recovery code works once");
        let a = r.assert(Surface::Desktop, &key(1), 1, 9, PAGE);
        assert_eq!(r.d("security:disable", json!([a])).unwrap()["enabled"], false);
        assert_eq!(r.sec.guard(Surface::Desktop, "remote:enable"), Ok(()));
    }

    #[test]
    fn removing_a_method_needs_a_different_one_and_keeps_the_minimum() {
        let r = on();
        let id1 = step_up::to_b64url(&[1; 16]);
        let same = r.assert(Surface::Desktop, &key(1), 1, 1, PAGE);
        let err = r.d("security:removeMethod", json!([id1, same])).unwrap_err();
        assert!(err.contains("different method"), "{err}");
        let totp_for_totp = json!({ "totp": r.totp() });
        assert!(r.d("security:removeMethod", json!(["totp", totp_for_totp])).unwrap_err().contains("different method"));
        let other = r.assert(Surface::Desktop, &key(2), 2, 1, PAGE);
        let status = r.d("security:removeMethod", json!([id1, other])).unwrap();
        assert_eq!(status["methods"].as_array().unwrap().len(), 1);
        // Two left with step-up on: the minimum.
        let err = r.d("security:removeMethod", json!(["totp", { "recovery": "x" }])).unwrap_err();
        assert!(err.contains("needs 2 methods"), "{err}");
    }

    #[test]
    fn removing_while_off_needs_nothing() {
        let r = rig();
        r.register(&key(1), 1, PAGE);
        let id1 = step_up::to_b64url(&[1; 16]);
        assert_eq!(r.d("security:removeMethod", json!([id1, null])).unwrap()["methods"], json!([]));
        assert!(r.d("security:removeMethod", json!([id1, null])).is_err());
    }

    #[test]
    fn the_same_key_twice_and_a_wrong_first_code_are_refused() {
        let r = rig();
        r.register(&key(1), 1, PAGE);
        let begin = r.d("security:registerBegin", json!(["passkey"])).unwrap();
        assert_eq!(begin["attachment"], "platform");
        assert_eq!(begin["excludeCredentials"].as_array().unwrap().len(), 1);
        let (cid, cdj, att) = registration(&key(1), begin["challenge"].as_str().unwrap(), 1, PAGE);
        let err = r
            .d(
                "security:registerKey",
                json!([{ "rpId": "localhost", "id": cid, "clientDataJSON": cdj, "attestationObject": att }]),
            )
            .unwrap_err();
        assert!(err.contains("already registered"), "{err}");
        r.d("security:totpBegin", json!([])).unwrap();
        assert!(r.d("security:totpConfirm", json!(["12345"])).unwrap_err().contains("didn’t match"));
    }

    #[test]
    fn a_damaged_file_says_so_and_refuses_guarded_calls() {
        let r = rig();
        r.mem.save(&json!({ "enabled": true })).unwrap();
        assert!(r.sec.guard(Surface::Desktop, "providers:save").is_err());
        let s = r.d("security:status", json!([])).unwrap();
        assert_eq!(s["damaged"], true);
        assert_eq!(s["methods"], json!([]));
    }

    #[test]
    fn every_desktop_guarded_class_from_the_shared_list_is_known() {
        for (action, channels) in &limits().desktop_guarded {
            for c in channels {
                let got = action_of(c);
                if NOT_COVERED.contains(&action.as_str()) {
                    assert_eq!(got, None, "{c}");
                } else {
                    assert_eq!(got.as_deref(), Some(action.as_str()), "{c}");
                }
            }
        }
        for c in
            ["remote:enable", "remote:attach", "remote:pair", "remote:rotate", "remote:setAccess", "providers:save"]
        {
            assert!(action_of(c).is_some(), "{c}");
        }
        for c in ["remote:disable", "remote:status", "app:quit", "remote:stop", "device:signOut"] {
            assert_eq!(action_of(c), None, "{c}: never guarded");
        }
    }
}
