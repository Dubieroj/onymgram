# Administering a group: create, invite, approve, anchor

Onymgram joins groups and chats in them; it does not create groups or approve joins. This document is what
an interface needs to do both, traced from the apps, the contracts and the relayer (commits in
[README.md](README.md)). "iOS" below is `onym-ios/Packages/…`, "Android" is `onym-android/modules/…`.

**The one thing that decides everything:** both apps check the group's commitment **on chain** before they
accept an invitation or an announcement. A group that is not anchored on the current Tyranny contract never
appears for a real Onym user (§6). So an admin must prove and anchor; there is no local-only mode.

## 1. Creating a group

iOS `OnymGroup/Sources/OnymGroup/CreateGroupInteractor.swift` 117–291; Android `group/…/CreateGroupInteractor.kt` 118–367.

1. Trim the name; each invitee key must be 32 bytes.
2. Pick the network (testnet unless the user opted into mainnet; no mainnet contracts exist yet) and the
   **Tyranny contract**: the user's explicit pick, else the newest release in
   `https://github.com/onymchat/onym-contracts/releases/latest/download/contracts-manifest.json` that has a
   `(testnet, tyranny)` entry (iOS `OnymChain/…/ContractsRepository.swift` 20–43). The contract id is **not**
   stored with the group or sent in any payload: every device re-resolves it. Latest on 2026-09-25: release
   v0.0.11, testnet tyranny `CAFX4A2KLOK7RE5QSPTDQ3UBCWOUSBPPFC2PU7M6ZP53GPGRCL67HNR3`.
3. Generate: `group_id` = 32 random bytes, big-endian, rejection-sampled until below r (canonical Fr; the
   contract refuses others with error #15; `randomCanonicalFr` 880–907). `group_secret` = 32 random bytes.
   `salt` = 32 random bytes (not reduced; the circuit reads it little-endian mod r). `tier` = 0 (depth 5).
   `epoch` = 0.
4. Roster = `[{public_key_compressed: own BLS public key, leaf_hash: H1(own BLS secret)}]`.
5. Prove **create** (§3) → `commitment = PI[0]`, `admin_pubkey_commitment = PI[2]`.
6. Anchor with `create_group` (§4). Any failure throws; **nothing is saved unless anchoring succeeded**.
7. Persist the group as admin: members, `memberProfiles[own BLS] = {alias, inbox key, sending key}`, epoch 0,
   salt, commitment, tier, `adminPubkeyHex` = own BLS, admin sending key = own, rules text, avatar.
8. Send an offer to each invitee (§5).

## 2. The contract (`onym-contracts/plonk/sep-tyranny/src/lib.rs`)

| Entrypoint | Lines | Arguments | Authorization |
|---|---|---|---|
| `create_group` | 252–370 | `caller: Address, group_id: BytesN<32>, commitment: BytesN<32>, tier: u32, admin_pubkey_commitment: BytesN<32>, proof: BytesN<1601>, public_inputs: Vec<BytesN<32>>` | `caller.require_auth()`; if restricted mode is on, caller must be the contract admin |
| `update_commitment` | 379–448 | `group_id, proof: BytesN<1601>, public_inputs: Vec<BytesN<32>>` | none — the proof is the authorization |
| `get_commitment` → `{commitment, epoch, timestamp, tier}` | 479 | `group_id` | read |
| `get_history(group_id, max_entries)` (64 kept) | 498 | | read |
| `get_admin_commitment`, `verify_membership`, `bump_group_ttl` (anyone) | | | |

`create_group` checks: tier ≤ 2; `commitment`, `admin_pubkey_commitment`, `group_id` canonical Fr; public
inputs exactly `[commitment, be32(0), admin_pubkey_commitment, group_id_fr]`; group new; ≤ 10,000 groups per
tier; proof never used before (SHA-256 replay set); proof verifies against the baked create key.
`update_commitment` checks public inputs against the stored `c_old`, epoch, admin commitment and
`group_id_fr`, verifies against the update key, archives the old entry and sets epoch + 1.
There is no "add member" call: the roster is off chain and only its commitment is anchored.

Deployed testnet contracts are probably unrestricted (every deploy script ends with
`set_restricted_mode(false)`, `scripts/bench-gas/contracts/sep-tyranny.sh`) — confirm by simulating a call.

## 3. Proofs

Circuits: `onym-contracts/plonk/prover/src/circuit/plonk/tyranny.rs`.

- **Create** (147–197). Public: `commitment, epoch = 0, admin_pubkey_commitment, group_id_fr`. Private: admin
  secret, `member_root`, `salt`, Merkle path, index bits. Proves `leaf = H1(sk)`,
  `H2(leaf, group_id_fr) = admin_pubkey_commitment`, the path from `leaf` to `member_root`, and
  `H2(H2(root, 0), salt) = commitment`.
- **Update** (201–269). Public: `c_old, epoch_old, c_new, admin_pubkey_commitment, group_id_fr`
  (`epoch_new = epoch_old + 1` enforced inside). Private: `sk`, both roots, both salts, the old path. Proves
  the admin binding and admin membership in the old tree; binds the new root into `c_new`.

System: TurboPlonk (`PlonkKzgSnark<Bls12_381>`), Espresso **jellyfish** (jf-plonk v0.8.0, jf-relation v0.5.0,
jf-pcs v0.3.0) on arkworks 0.5, keccak256 transcript. Proof 1601 bytes; public inputs 32 bytes big-endian each.
Proving keys are derived at run time from the **Ethereum Foundation 2023 KZG SRS** compiled into the library
(`plonk/prover/src/prover/srs/ef-kzg-2023.bin`, 3,158,224 bytes, n = 32768, SHA-256 pinned by `build.rs`).
Nothing is downloaded. About 3.5 s per proof on a phone, single-threaded.

How to call it:

| Platform | API |
|---|---|
| iOS | onym-sdk-swift 0.0.2 (`OnymFFI.xcframework`): `Tyranny.proveCreate(depth:memberLeafHashes:adminSecretKey:adminIndex:groupIdFr:salt:)`, `Tyranny.proveUpdate(…)` (iOS `OnymChain/…/GroupProofGenerator.swift` 192–379) |
| Android | `chat.onym:onym-sdk:0.0.2` (AAR with `libonym_sdk_jni.so`, static Maven repo on onym-sdk-kotlin's `releases` branch — see `onym-android/settings.gradle.kts` 19–30): `chat.onym.sdk.Tyranny.proveCreate/proveUpdate` (`chain/…/GroupProofGenerator.kt` 253–448) |
| Rust / C (desktop) | `onym-contracts/plonk/sep-tyranny-ffi/src/lib.rs`: `onym_tyranny_prove_create` (336–448), `onym_tyranny_prove_update` (475–621); returns the proof plus 128 (create) or 160 (update) bytes of public inputs |
| Browser | nothing yet. The crates are pure Rust with no threads, so `wasm32-unknown-unknown` is feasible: enable `getrandom`'s `js` feature (or seed from `crypto.getRandomValues`), replace the C ABI with wasm-bindgen exports, and embed only the SRS prefix the circuit's domain needs |

**Pin the circuit to the deployed contract.** The verifying keys are baked into the contract; a proof from a
different circuit version fails on chain. The local checkout is v0.0.13, the deployed manifest v0.0.11: prove
once and simulate `create_group` against the live contract before trusting a build.

## 4. Submitting contract calls

**The apps' relayer is not usable by a third-party interface.** The apps `POST https://relayer.onym.app/`
(list from `onym-relayer/releases/latest/download/relayers.json`) with

```json
{"network":"testnet","contractID":"C…","contractType":"tyranny","function":"create_group",
 "payload":{"group_id":b64,"commitment":b64,"tier":0,"admin_pubkey_commitment":b64,"proof":b64,
            "publicInputs":[b64 commitment, b64 32×00, b64 admin_commitment, b64 group_id_fr]}}
update: "function":"update_commitment","payload":{"group_id","proof","publicInputs":[c_old, be32(epoch_old), c_new, admin_comm, group_id_fr]}
```

and `Authorization: Bearer <token>`, a secret compiled into the app builds (iOS `RelayerSecrets.json` from a
CI secret, Android `BuildConfig.RELAYER_AUTH_TOKEN`). Nothing documents how another interface gets one, and
the relayer sends no CORS headers. The relayer only checks sizes and its contract allowlist, then runs
`stellar contract invoke` from its own funded account; the contract verifies the proof.

Workable routes:

1. **Directly to Soroban RPC, one throwaway account per transaction** (no server). Create a random Stellar key,
   fund it with Friendbot (`https://friendbot.stellar.org/?addr=G…`), build the invocation with that account
   as source and as `caller`, simulate (`prepareTransaction`), sign, `sendTransaction`, poll `getTransaction`.
   RPC `https://soroban-testnet.stellar.org`, passphrase `Test SDF Network ; September 2015`. A fresh account
   per call keeps groups unlinkable (the relayer achieves that with one shared account). Testnet only.
   On 2026-09-25 both the RPC and Friendbot answered browser CORS preflights; GitHub release downloads do not
   (fetch the manifest through your own server or at build time).
2. **Your own relayer.** onym-relayer is MIT; it needs only `RELAYER_SECRET_KEY` (a funded account); auth is
   off when `RELAYER_AUTH_TOKENS` is empty; add CORS at the reverse proxy for a browser. Leave
   `RELAYER_OPERATOR_MANIFEST` unset (the image carries Onym's own).

Declare whichever you use as a labelled, replaceable default (Interface.md; `UI-Notary-Stellar.md` 577–580
asks that a self-paying variant be disclosed).

## 5. Inviting by inbox key

Only inside group creation in the apps (iOS `CreateGroupFlow.swift` 172–253); for an existing group they share
a join link. For each invitee:

1. Mint a fresh X25519 **intro key** (`InviteIntroducer.mint`, 50–83); keep its secret until the join is done.
2. Send an offer sealed to the invitee's inbox key, published to their inbox tag:
   `{"offer_version":1,"intro_pub":b64,"group_id":b64,"group_name":…,"inviter_alias":…,"invitation_message"?}`
   (omit `invitation_message` when empty). The offer grants nothing by itself.
3. Subscribe to every live intro key's inbox tag (`IntroInboxPump.swift` 79–108) and open join requests with
   the intro secret (`JoinRequestApprover.swift` 1284–1351).

A join link is the same capability for many people: `{"intro_pub", "group_id", "group_name"?, "rules"?}` (protocol.md §2).

## 6. Approving a join request (iOS `JoinRequestApprover.swift`; Android `JoinRequestApprover.kt` 415–564, 631–715)

On arrival: the intro key exists and is not revoked; the envelope opens; `group_id` matches the intro key's
group; merge duplicates by (BLS key or inbox key, group). The rules agreement is classified
(`agreed / invalid / unknownRules / notSigned / notRequired`, 1400–1425) and **shown** to the admin; it does not
block approval.

On Approve:

1. The request must carry `joiner_bls_pub` and `joiner_leaf_hash`; we must be this group's admin (our BLS key
   equals `members[adminIndex]`). A joiner already in the roster just gets the invitation again.
2. `newMembers` = roster + joiner, sorted by compressed BLS key; `rootNew` at the tier's depth;
   `saltNew` = 32 random bytes.
3. `proveUpdate(old leaves, adminSk, adminIndexOld, epochOld, rootNew, groupId, saltOld, saltNew)`.
4. **Persist a pending anchor with `saltNew` before submitting**; refuse to approve if it cannot be written
   (`PendingAnchor.swift` 181–264).
5. `update_commitment`. Error #5 = group not anchored yet. Error #10 = someone else moved the epoch: read the
   chain, adopt whichever attempt landed or rebase, retry once (898–990).
6. On success persist members, `commitment = PI[2]`, `epoch + 1`, `salt = saltNew`.
7. **Invitation to the joiner** (440–508), sealed to `joiner_inbox_pub`, with the post-anchor state (fields in
   protocol.md §5). `member_profiles` includes the admin's own row (joiners need it to ask for refreshes) and
   the joiner's row with their rules signature.
8. **Announcement to every other member** (1069–1149), best effort:
   `{"version":1,"group_id","new_member":{"bls_pub","inbox_pub","alias","sending_pub",rules…},"admin_alias","commitment","epoch"}`.
9. Record the joiner, revoke the spent intro key (1245–1253).

**Refresh requests** (`{"refresh_version","refresh_group_id","requester_inbox_pub","requester_bls_pub"}`): answer
with a fresh invitation if the requester is a current member whose signing key matches
(iOS `OnymInbox/…/GroupStateVerifier.swift` 296–359).

## 7. What receivers verify

iOS `OnymInbox/…/IncomingMessageDispatcher.swift` (Android `inbox/…/IncomingMessageDispatcher.kt` 282–340,
1082–1190, 1260–1290 does the same with a production chain reader):

- **Invitation** (389–429, 786–905): a commitment must be present and recompute from the roster; then
  `get_commitment` on the receiver's own resolved contract. Not found → parked as "chain settling"; chain epoch
  behind the invitation → parked; equal epoch → commitments must match; chain ahead → `get_history(64)` must
  contain the same commitment at that epoch.
- **Announcement** (927–955): commitment and epoch present; chain epoch ≥ claimed; equal epoch → same
  commitment; and signed by the admin key captured from the invitation (993–1010).
- Chain reads are cached 10 s with 3 retries. Anarchy / OneOnOne groups skip this check, but their chat is not
  accepted as Tyranny, so they are no shortcut.

Consequences: anchor on exactly the contract the **latest manifest** names for `(testnet, tyranny)` — and
watch the manifest, because when a new release appears the apps move to it and groups on the old contract stop
verifying. Onymgram's own joiner side does not yet read the chain; a full interface should.

Open questions: whether each write's storage TTL (about 30 days of ledgers) expires for idle groups (neither app
calls `bump_group_ttl`); whether `relayer.onym.app` really rejects calls without a token (the apps assume so).
