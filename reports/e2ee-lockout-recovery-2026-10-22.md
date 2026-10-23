# E2EE account recovery: what other companies do, and what Nekko Agent should do

*Research for the Nekko Cloud sync design (`docs/SYNC-ENCRYPTION.md`). 2026-10-22.*

**Method and caveats.** Direct page fetches were blocked from this environment, so facts were gathered through web search over vendor pages, vendor engineering blogs and papers. Where a claim rests on a secondary source, or on my prior knowledge and could not be re-checked here, it is marked **[unverified]**. Footnote numbers refer to the Sources list.

## Short answer to the founder's question

None of the serious E2EE vendors keep a backup key that they can use on their own. Recovery comes in five forms:

1. **A key the user keeps.** Examples are a recovery key, an emergency kit or a recovery phrase. Nekko already does this.
2. **Other devices the user owns.** Nekko already does this too.
3. **A trusted person.** The user names a contact. Apple splits the secret between the contact and Apple, so neither can recover it alone.
4. **A short PIN or passcode, stored in tamper-resistant hardware** (HSMs or secure enclaves) that permanently destroys the secret after about 10 wrong guesses. Apple, Google, WhatsApp/Messenger and Signal all do this. It is the only way consumer apps let users recover with something they can remember. It works because the hardware stops the server from brute-forcing the PIN. In return, "we can't read it" now depends on trusting that hardware and the code running on it.
5. **An org admin.** In business plans the user's key is wrapped to an organization key that admins hold (Bitwarden, 1Password, Dashlane, Tresorit). The vendor is not in that chain.

Nekko's reason for rejecting a password-derived key (the server could brute-force it offline) is exactly the problem pattern 4 solves with hardware attempt limits.

## Vendor findings

### Apple (iCloud Keychain, Advanced Data Protection)
- **iCloud Keychain escrow.** The escrow record sits behind clusters of HSMs and is unlocked with the user's iCloud security code, which is the device passcode. The code is checked with SRP, so Apple never receives it. Recovery allows 10 attempts. After several failures the record locks until the user contacts Support, and on the 10th failure the HSM cluster destroys the record and the keychain is lost for good. The attempt policy is in HSM firmware, and the cluster deletes its private key if anyone tries to change the firmware. [1] Apple's whitepaper says the HSM administrator access cards were destroyed after setup, so Apple cannot change the firmware either. **[unverified this session; prior knowledge of the Platform Security guide]**
- **Advanced Data Protection (ADP).** With ADP on, 25 iCloud data categories become E2EE. Apple says it does "not have the encryption keys to help you recover" this data. Recovery uses a trusted device's passcode or password, a recovery contact, or a recovery key, and at least one of the last two must be set up before ADP can be turned on. [2][3] The recovery key is 28 characters (secondary source). [4]
- **Recovery contact cryptography.** A user can name up to five contacts. At setup the device makes a key for each contact that protects the user's iCloud data. That key is encrypted under a random 256-bit AES key. The encrypted packet goes to the contact over an E2EE CloudKit container, and Apple keeps the AES key. Recovery needs both halves. Apple learns who the contact is only late in a recovery attempt. [5] The Legacy Contact (for after death) reverses the split: Apple holds the packet, the beneficiary holds the AES key, and the keychain is excluded. [5]
- **Incident.** In February 2025 Apple withdrew ADP for new UK users after a reported Technical Capability Notice under the Investigatory Powers Act. Apple chose to withdraw the feature rather than add access. Keychain, Health and iMessage stayed E2EE in the UK. [6][7] Lesson: a design where the vendor truly holds nothing leaves "turn the feature off" as the only option under legal pressure. A design with a vendor-held escrow key could be compelled to hand data over.

### Google
- **Android backups (Cloud Key Vault, since Android 9).** The backup key is protected by the lock-screen PIN, pattern or password and held in Titan chips in Google's data centres. The chip releases the key only to a correct passcode claim and limits wrong attempts. The limit is enforced by custom Titan firmware that cannot be updated without erasing the chip. Google states it "has no ability to access or restore" the backup contents. [8][9]
- **Google Password Manager / passkeys.** Keys can be restored on a new device by signing in to the Google Account and entering the screen lock of an existing device. The attempt limit "is always 10 or less", and Google may block attempts earlier. Google does not know the screen-lock PIN. [10] In optional "on-device encryption" mode the user unlocks with their Google password or screen lock, and the mode cannot be turned off once set. Google warns that losing the key can mean losing the passwords. [11]

### WhatsApp and Messenger (Meta)
- **Two options for E2EE backups.**
  - A 64-digit key that the user stores; Meta cannot help if it is lost.
  - A password, with the backup key held in an HSM-based Backup Key Vault. The vault enforces attempt limits and makes the key "permanently inaccessible after a limited number of unsuccessful attempts". [12] An academic analysis of the deployed protocol puts the limit at ten wrong guesses and says this should hold even if the WhatsApp server is compromised. [13] The vault uses OPAQUE (a password-authenticated key exchange), so it checks the password without learning it (secondary source). [14]
- **Passkeys (October 2025).** Backups can also be encrypted with a passkey (biometric or screen lock), which takes away the burden of remembering a password. [15]
- **2026 hardening.** The vault is a geographically distributed HSM fleet with majority-consensus replication. Meta added fleet public keys for Messenger delivered over the air, in bundles signed by Cloudflare and counter-signed by Meta, with Cloudflare keeping an audit log of the bundles. Meta also committed to publish evidence that each new fleet was deployed securely. [16] This answers the main criticism of HSM escrow: users had to trust the vendor that the HSM existed and was set up correctly.
- **Messenger (Labyrinth).** Stored history is recovered with a PIN or recovery code. [17][18]

### Signal
- **Secure Value Recovery (SVR).** The PIN plus a random seed derive the key that protects the user's data. Enclaves limit PIN guesses, so Signal cannot brute-force a short PIN. [19][20]
  - SVR (2020) ran on Intel SGX.
  - SVR2 is a transition system: a partial build of SVR3.
  - SVR3 splits trust across three enclave types from three vendors on three clouds: Intel SGX on Azure, AMD SEV-SNP on Google Cloud and AWS Nitro. It has rollback protection, because rolling back enclave state would give an attacker more PIN guesses. The paper reports a cost of about $0.0015–0.0025 per user per year. [21][22]
  - The exact guess limit is **[unverified]**.
- **Without the PIN.** Signal cannot reset or recover the PIN. With Registration Lock on, a user who forgets the PIN can be locked out of the number for up to 7 days, then can re-register without the old PIN-protected data. [23]
- **Secure Backups (September 2025).** Message-history backups use a 64-character recovery key generated on the device. Signal cannot recover it if lost. [24]
- **Criticisms.** SGX side channels such as SGAxe extracted SGX attestation keys from fully patched machines. [25] Critics argued Signal's SVR security reduces to trusting Intel. [26] SVR3's split across several vendors is Signal's response.

### 1Password
- **Unlocking.** The account password is combined with a 128-bit Secret Key that only the user's devices and the Emergency Kit hold (two-secret key derivation). The server therefore cannot brute-force the password alone. 1Password says it cannot recover data if both are lost. [27] The 128-bit size and the two-secret derivation details are **[unverified this session; prior knowledge]**.
- **Family and team recovery.** Recovery uses a Recovery Group: a group keypair whose private key is encrypted to each member's public key. Every vault key is also encrypted to the Recovery Group's public key. In a recovery the user generates a new keyset, and a group member (an organizer or admin) re-encrypts the vault keys to it. 1Password staff say the server stops recovery-group members from fetching the vault *data*. That is a server-side rule, not a cryptographic barrier: a member who also had the server's ciphertext could decrypt it. [28][29] AgileBits itself is not in the Recovery Group and cannot add itself, because membership requires encrypting the group key to the new member. [29] The whitepaper admits there is no public-key verification, so a malicious server could in theory substitute keys during sharing or recovery (whitepaper section titles via secondary source). [29][30]
- **Recovery codes (2024).** These are a newer self-service option. [31]

### Bitwarden
- **Emergency access.** User to user: the vault key is encrypted to the grantee's RSA public key, with a waiting period the owner can cancel during. [32]
- **Enterprise account recovery.** When a user enrolls, their encryption key is encrypted with the organization's public key and stored as the "Account Recovery Key". An admin decrypts the org private key, unwraps the user key, and sets a new master password. Bitwarden warns this "could allow an administrator to access their individual vault data". With auto-enrollment, users cannot opt out. [33][34]

### Proton
- **Two steps.** Recovery separates password reset (regaining access to the account) from data recovery (decrypting the data). A recovery phrase generated on the device covers both, and Proton stores only a verifier for it. A recovery file, or a "device data backup" kept in browser storage, holds an encrypted copy of the keys for data recovery only. If the user resets the password with no data-recovery method, everything from before the reset is unreadable. [35][36]

### Others
- **Ente.**
  - A 24-word recovery key. Without it or the password: "we cannot recover your account or data". [37]
  - **Legacy** trusted-contact recovery: an existing Ente user starts recovery, and the owner can block it during a 7, 14 or 30-day wait. After the wait the contact gets full account access. [38]
  - **Legacy Kits:** a printable variant with a configurable delay. [39]
- **Tresorit.** Recovery works only from a device that is still logged in, or by an owner admin under Business "Advanced Control". Otherwise a reset deletes all files. [40]
- **Dashlane.**
  - A user-held Account Recovery Key encrypts the master password locally. [41]
  - Admin-assisted recovery for business plans is on by default but each member must accept it. Dashlane calls it zero-knowledge; the cryptography is **[unverified]** (whitepaper body not retrieved). [41][42]
- **X/Twitter XChat.** Uses Juicebox, an open-source threshold OPRF scheme for recovering secrets with a PIN. Matthew Green criticized the deployment for using non-HSM servers that one operator controls. [43][44]

## 1. Comparison

| Vendor / feature | Recovery mechanisms | Can the vendor decrypt? | Brute-force protection | User burden |
|---|---|---|---|---|
| Apple iCloud Keychain | Other device; device passcode via HSM escrow | No; needs passcode through HSM; HSM firmware locked [1] | 10 tries then record destroyed [1] | Low (remember phone passcode) |
| Apple ADP | Device passcode, recovery contact, 28-char recovery key [2][4] | No. Holds only half of recovery-contact secret [5] | HSM limits for passcode path | Medium (must set contact or key) |
| Google Android backup / GPM | Old device screen lock via Titan HSM; Google password (GPM on-device mode) [8][10][11] | No (per Google) | ≤10 tries, Titan firmware [10] | Low |
| WhatsApp backups | 64-digit key; password or passkey via HSM vault [12][15] | No; password checked with OPAQUE inside HSM [14] | 10 guesses then key destroyed [13] | Low to medium |
| Messenger (Labyrinth) | PIN / recovery code via HSM vault [16][17] | No (per Meta) | HSM limit; attested fleet keys [16] | Low |
| Signal | PIN via SVR enclaves; 64-char backup key [21][24] | No, if enclaves hold | Enclave guess limit (number **[unverified]**); SVR3 needs 3 vendors broken [21] | Low; forgotten PIN = lose that data |
| 1Password | Secret Key + password (Emergency Kit); Recovery Group (organizers/admins); recovery codes [27][28][31] | No. Admins can recover family/team members; AgileBits cannot [29] | 128-bit Secret Key makes offline guessing useless | Medium (store kit) |
| Bitwarden | Master password; emergency access; Enterprise admin recovery [32][33] | No. Org admins can [33] | Password KDF only | Medium |
| Proton | Recovery phrase; recovery file; device backup [35][36] | No | Phrase is high-entropy | Medium; reset without a data-recovery method = data loss |
| Ente | 24-word key; trusted contact with delay [37][38] | No. Contact can after the wait [38] | High-entropy key | Medium |
| Tresorit / Dashlane | Logged-in device; admin reset (business); recovery key [40][41] | No. Admins can (Tresorit) / claimed zero-knowledge (Dashlane) | n/a | Medium |
| **Nekko today** | Other device; 256-bit recovery key | No | 256-bit key | Medium; no fallback |

## 2. Taxonomy of patterns

| Pattern | Examples | Who can decrypt | Main risk |
|---|---|---|---|
| A. High-entropy key the user keeps | Nekko, ADP key, WhatsApp 64-digit, Signal backups, Proton phrase, Ente, 1Password Emergency Kit | User only | Users lose it; loss is permanent |
| B. Multi-device only | Tresorit, Apple and Google "use another device" | User's devices | Losing every device (theft, fire) |
| C. Social / contact, split with vendor | Apple recovery contact (contact + Apple) | Contact and vendor together | Contact and vendor collude; contact unavailable |
| C′. Social / contact, delay only | Ente Legacy, Bitwarden emergency access, Apple Legacy Contact | Contact alone after the wait | Contact turns malicious; owner misses the alert |
| D. HSM/enclave escrow behind a low-entropy PIN | Apple Keychain, Google CKV, WhatsApp/Messenger vault, Signal SVR, Juicebox | Nobody, if the hardware and code hold. The vendor could if it can change the firmware or code | Trusting the hardware and the operator; side channels; rollback |
| E. Admin / org escrow | Bitwarden Enterprise, 1Password Recovery Group, Dashlane, Tresorit | Org admins | Admin abuse; server substitutes a key |
| F. Vendor-held escrow key | Classic iCloud (non-ADP), most SaaS | Vendor alone | Breaks "we can't read it"; compelled disclosure |

Every serious vendor except F still truthfully claims the vendor cannot decrypt. The industry answer to "help locked-out users" is D for consumers and E for businesses, with C as the privacy-preserving middle.

## 3. Recommendation for Nekko Agent

**Context that lowers the stakes.** Nekko is local-first. Every chat also lives on the user's devices, so the synced copy is lost only if every device is lost *and* the recovery key is gone. That is rarer than with a password manager or a messenger. Spend accordingly.

Ranked options, all of which keep "Nekko Labs cannot read your messages" true:

### 1. Make the existing recovery key and second device harder to lose (do now)
- **What.**
  - A printable "Recovery Kit" PDF with the key and a QR code.
  - A required "type the last group" confirmation at setup.
  - Periodic nudges to re-verify the key: the device checks it against the recovery wrap locally, and nothing is sent.
  - A "you only have one device, add your phone" prompt.
  - Optionally, saving the key to the OS password manager or iCloud Keychain. (This makes Apple/Google part of the trust path, so label it as such.)
- **Nekko or an attacker with the server can do:** nothing new.
- **Complexity:** low (UI only). **Cost:** none.
- **Pros:** this is where 1Password, Proton and Ente put most of their effort. **Cons:** it doesn't help someone who never saved the key.

### 2. Recovery contact, Apple-style split (next; best ratio of value to trust)
- **What.**
  - The owner's device generates a random contact key `Kc` and uploads a new wrap of the keyring under `Kc`.
  - It splits `Kc` into two shares, `Kc = s1 ⊕ s2`, or uses Apple's scheme of encrypting `Kc` under a random AES key. `s1` goes end-to-end encrypted to the contact's Nekko device key; Nekko Cloud stores `s2`.
  - **Recovery:**
    - The user signs in on a new device and asks the contact for help.
    - The contact compares the new device's key fingerprint with the user out of band (a call or in person), using the same short-code check Nekko already uses for adding devices.
    - The contact's device sends `s1` encrypted to that device key.
    - Nekko releases `s2` only after a waiting period (for example 72 hours). During that wait every remaining device and the account email get a notice and can cancel.
  - The keyring wrap must be re-made for each key epoch, just as the recovery wrap is.
- **What each party can do:**
  - Nekko or a server attacker alone: nothing. They hold `s2` and the wrap, but not `s1`.
  - The contact alone: nothing.
  - **Nekko and the contact colluding: everything.**
  - A malicious server could try to get the contact to send `s1` to a device the server registered. The fingerprint check is the defence.
- **Complexity:** medium (invites, a new wrap type, a release flow with delay and cancel, epoch rewrap). **Cost:** negligible.
- **Pros:** proven at Apple's scale [5]; Nekko holds nothing usable on its own; it fits a developer audience where the contact is often a teammate.
- **Cons:** the contact must be a Nekko user with a device. Without the split, an Ente-style contact (C′) would let the contact decrypt alone, which is weaker.

### 3. Team plan: opt-in org recovery key (for Team, alongside or before 2)
- **What.**
  - A Team admin's device creates an org recovery keypair and wraps its private half to each admin's device key, like 1Password's Recovery Group.
  - Members who opt in also wrap their keyring to the org public key.
  - Admins see the org key's fingerprint, and members' devices pin it at enrollment so a server-substituted key is rejected. This closes the gap 1Password documents. [30]
  - Every use of the org key is logged and the member is notified.
- **What each party can do:** Nekko, nothing. **Team admins: read opted-in members' synced chats**, as with Bitwarden. [33]
- **Complexity:** medium. **Cost:** none.
- **Pros:** businesses expect it. **Cons:** it must stay opt-in per member, with honest copy.

### 4. Optional PIN escrow in hardware (defer until scale or demand justifies)
- **What.**
  - The keyring is wrapped under a key that only comes back with a PIN or passcode, from a service that destroys it after about 10 wrong guesses.
  - **Build options:**
    - **(a) Juicebox SDK** (open source, Rust with Swift, Android and JS bindings) spread across ≥2 independently operated "realms", for example one run by Nekko and one by a third party. [43][45]
    - **(b) An AWS Nitro Enclave** running OPAQUE with a guess counter. AWS KMS releases the sealing key only to an attested enclave image. Nitro Enclaves have no extra charge beyond the EC2 instance. [46][47]
    - **(c) AWS CloudHSM.** About $1.60/hr per HSM according to a secondary source; two for high availability is roughly $2.3k a month before engineering. **[unverified current price]** [48]
- **What each party can do:**
  - Server-database thief: nothing.
  - Nekko as operator: in (b), anyone who can deploy a new enclave image and change the KMS policy could pull escrowed secrets or remove the guess limit. Mitigations: reproducible builds, publishing enclave measurements, a transparency log. In (a), Nekko alone cannot, if the other realm is truly independent. These are the same trust questions raised against Signal and XChat [25][44], which Meta answered with attested fleets. [16]
  - Rollback of the guess counter is a real attack (Signal's SVR3 paper). [21]
- **Complexity:** high (distributed state, attestation, operations, an outside audit). **Cost:** low on Juicebox/Nitro infrastructure; mostly engineering time and an audit.
- **Pros:** the best user experience; it is what WhatsApp, Apple and Google do. **Cons:** it weakens the absolute claim to "cannot, provided the hardware and our published code hold". Ship only as opt-in with that exact wording.

### Do not do
- **A vendor-held escrow key, or a password-derived key without hardware limits.** Either breaks the core promise. Either also creates something a government could compel Nekko to use; the UK and ADP case shows that pressure is real. [6]

### Suggested sequence
1. Option 1 before launch.
2. Option 2 (and option 3 for Team) as the first post-launch recovery feature.
3. Revisit option 4 once paid sync users are numerous enough that lockout support becomes costly, preferring multi-operator Juicebox over a single-operator enclave.
4. Have the planned outside cryptography review cover whichever of options 2–4 ships.

## Sources
1. Apple Platform Security – Escrow security for iCloud Keychain: https://support.apple.com/guide/security/sec3e341e75d/web
2. Apple – iCloud data security overview: https://support.apple.com/102651
3. Apple – Advanced Data Protection privacy: https://www.apple.com/legal/privacy/data/en/advanced-data-protection/
4. Apple – Set up a recovery key: https://support.apple.com/109345 ; 28-char length via https://iphonelife.com/content/how-to-enable-advanced-data-protection (secondary)
5. Apple Platform Security – Account recovery contact security: https://support.apple.com/guide/security/secafa525057/web
6. Al Jazeera, Apple drops E2EE cloud encryption for UK users (Feb 2025): https://www.aljazeera.com/economy/2025/2/21/apple-in-a-first-drops-end-to-end-cloud-encryption-for-uk-users
7. Privacy Guides discussion: https://discuss.privacyguides.net/t/the-uk-government-forced-apple-to-remove-advanced-data-protection-what-does-this-mean-for-you/25351
8. Google Cloud Key Vault Service whitepaper: https://developer.android.com/about/versions/pie/security/ckv-whitepaper
9. SecurityWeek on Titan-backed Android backups: https://www.securityweek.com/google-boosts-protection-backups-android
10. Google Security Blog – Security of Passkeys in Google Password Manager: https://security.googleblog.com/2022/10/SecurityofPasskeysintheGooglePasswordManager.html
11. Google – On-device encryption: https://support.google.com/accounts/answer/11350823
12. Meta Engineering – WhatsApp E2EE backups (2021): https://engineering.fb.com/2021/09/10/security/whatsapp-e2ee-backups/
13. IACR ePrint 2023/843 (analysis of WhatsApp backup protocol): https://eprint.iacr.org/2023/843.pdf
14. CyberInsider on Meta backup whitepaper / OPAQUE (secondary): https://cyberinsider.com/meta-enhances-security-of-whatsapp-and-messenger-encrypted-backups/
15. Help Net Security – WhatsApp passkey backups (Oct 2025): https://www.helpnetsecurity.com/2025/10/30/whatsapp-secure-chat-backups-passkeys/
16. Meta Engineering – HSM-based Backup Key Vault (May 2026): https://engineering.fb.com/2026/05/01/security/meta-strengthening-end-to-end-encrypted-backups/
17. Meta – Labyrinth protocol whitepaper: https://engineering.fb.com/wp-content/uploads/2023/12/theLabyrintHencryptedMessagestorageProtocol_12-6-2023.pdf
18. Meta Engineering – Labyrinth 1.1: https://engineering.fb.com/2026/05/11/security/labyrinth-1-1-end-to-end-encrypted-e2ee-backups-more-reliable/
19. Signal – Technology preview for secure value recovery: https://signal.org/blog/secure-value-recovery/
20. Signal – Improving Registration Lock with SVR: https://signal.org/blog/improving-registration-lock/
21. Connell et al., Secret Key Recovery in a Global-Scale E2EE System (OSDI '24): https://www.usenix.org/conference/osdi24/presentation/connell ; https://eprint.iacr.org/2024/887
22. SVR3 project page: https://sky.cs.berkeley.edu/project/svr3/
23. Signal Support – Signal PIN: https://support.signal.org/hc/en-us/articles/360007059792
24. Signal – Introducing Secure Backups: https://signal.org/blog/introducing-secure-backups/
25. SGAxe paper: https://sgaxe.com/files/SGAxe.pdf
26. Palant, Does Signal's secure value recovery really work?: https://palant.info/2020/06/16/does-signals-secure-value-recovery-really-work/ ; M. Green: https://blog.cryptographyengineering.com/2020/07/
27. 1Password Security Design white paper: https://1password.com/files/1password-white-paper.pdf ; Secret Key: https://support.1password.com/secret-key-security/
28. 1Password community – recovery flow: https://1password.community/discussion/comment/379690
29. 1Password community – Recovery Group keys (staff answers): https://1password.community/discussion/comment/576998
30. 1Password community – public key MITM: https://1password.community/discussion/comment/519499/
31. 1Password – Recovery code security: https://support.1password.com/recovery-code-security/
32. Bitwarden – Emergency access: https://bitwarden.com/help/emergency-access/
33. Bitwarden – About account recovery: https://bitwarden.com/help/account-recovery/
34. Bitwarden – Admin password reset: https://bitwarden.com/help/admin-reset
35. Proton – Account recovery explained: https://proton.me/support/set-account-recovery-methods
36. Proton blog – Data recovery and E2EE: https://proton.me/blog/data-recovery-end-to-end-encryption
37. Ente – Security and privacy FAQ: https://ente.com/help/photos/faq/security-and-privacy
38. Ente – Legacy: https://ente.com/help/photos/features/account/legacy/
39. Ente – Legacy Kit: https://ente.com/blog/legacy-kit
40. Tresorit – Forgot your password: https://support.tresorit.com/hc/en-us/articles/216114497-Forgot-your-password
41. Dashlane – Admin-assisted recovery: https://www.dashlane.com/blog/admin-assisted-recovery ; Zero-knowledge account recovery: https://support.dashlane.com/hc/en-us/articles/115005111905-Zero-knowledge-Account-Recovery
42. Dashlane whitepaper (2021): https://www.dashlane.com/uploads/2021/07/whitepaper.pdf
43. Juicebox protocol paper (ePrint 2025/348): https://eprint.iacr.org/2025/348 ; SDK: https://github.com/juicebox-systems/juicebox-sdk
44. M. Green on XChat/Juicebox: https://blog.cryptographyengineering.com/2025/06/09/a-bit-more-on-twitter-xs-new-encrypted-messaging/
45. Juicebox HSM realm: https://github.com/juicebox-systems/juicebox-hsm-realm
46. AWS Nitro Enclaves FAQ (pricing): https://aws.amazon.com/ec2/nitro/nitro-enclaves/faqs/
47. AWS KMS condition keys for Nitro Enclaves: https://docs.aws.amazon.com/kms/latest/developerguide/conditions-nitro-enclaves.html
48. AWS CloudHSM pricing: https://aws.amazon.com/cloudhsm/pricing/ (rate via secondary calculator https://www.factualminds.com/tools/aws-cloudhsm-pricing-calculator/)
