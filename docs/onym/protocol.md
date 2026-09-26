# The Onym protocol, as a member speaks it

Everything in this document is implemented in `src/api/onym/core/` and `src/api/onym/messenger.ts`, and was
checked against the Onym iOS app on the live network. Formats are byte-compatible with onym-ios and
onym-android: where the two apps differ (iOS omits absent optionals, Android sends `null`), accept both.
Run the tests with `npx vitest run -c vitest.onym.config.ts`.

## 1. Identity

A BIP-39 phrase (12 words, English list, no passphrase) is the whole identity. There is no account.

```
seed    = BIP-39 seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic")
nostr   = HKDF-SHA256(ikm = seed,  salt = "app.onym.bip39", info = "nostr-secp256k1-v1",      32 bytes)
bls     = HKDF-SHA256(ikm = seed,  salt = "app.onym.bip39", info = "bls12-381-v1",            32 bytes)
sending = HKDF-SHA256(ikm = nostr, salt = "app.onym.ios",   info = "stellar-ed25519-v1",      32 bytes)  Ed25519 seed
inbox   = HKDF-SHA256(ikm = nostr, salt = "app.onym.ios",   info = "x25519-key-agreement-v1", 32 bytes)  X25519 secret
```

- The BLS secret is read as a **big-endian** integer reduced mod r (BLS12-381 scalar field; arkworks
  `from_be_bytes_mod_order`). The public key is compressed G1, 48 bytes, ZCash/arkworks encoding.
- The sending key's public half is also a Stellar account (`G…`, StrKey of the Ed25519 public key).
- **Inbox tag** — the address others publish to: `hex(SHA-256("sep-inbox-v1" ‖ inboxPublicKey)[0..8])`.

Cross-platform fixture, pinned by onym-ios `IdentityRepositoryTests` and `core/identity.test.ts`:

| For `abandon ×11 about` | Value |
|---|---|
| nostr public key | `d8631b8e96d3d3d6d42cdadd07bc6db04108367dc2ce2d5e9b9a524123dc0821` |
| BLS public key | `a5859e962056987df69617fa41318641def18a1f78959951d1cf07bd164a6dcb50962786c8ead48c4e6aab5db6ce8f10` |
| sending public key | `7a33c09cdb7f51fe723a4003d2f28272cddc8fa2cf3d74a374a5f2ee6fb1fcdc` |
| Stellar account | `GB5DHQE43N7VD7TSHJAAHUXSQJZM3XEPULHT25FDOSS7F3TPWH6NYJ7A` |
| inbox public key | `66ac34309b3b73163b628c2c40174ea76d58d4eb769172611e5c42f9a0cefe5f` |
| inbox tag | `f462ae97384bd242` |

## 2. Links

- **Identity link** (someone with it can invite you): `https://onym.app/i?k=<base64url(inbox public key)>`.
  Also accept a bare 64-character hex key and the legacy `?payload=<hex>`.
  **The iOS app's "Invite by Inbox Key" paste field takes only the 64-hex key**; the link works there only
  through its QR scanner. Offer both "Copy key" and the QR code.
- **Join link**: `https://onym.app/join?c=<c>` or `onym://join?c=<c>`, where `c` is unpadded base64url of JSON
  `{"intro_pub": b64, "group_id": b64, "group_name"?: string, "rules"?: string}` (fields in padded base64).

## 3. Sealed envelope `x25519-aes-256-gcm-v1`

Every inbox payload is sealed to one recipient (onym-ios `SealedEnvelope`, `IdentityRepository.sealInvitation`):

1. Fresh X25519 key pair; shared = X25519(ephemeral secret, recipient inbox public key).
2. key = HKDF-SHA256(shared, salt `"sep-invitation-v1"`, info `"aes-256-gcm"`, 32 bytes).
3. AES-256-GCM, 12-byte random nonce, **no AAD**.
4. The sender's Ed25519 **sending** key signs the 32-byte ephemeral public key.

Serialized as JSON (UTF-8), byte fields padded standard base64:

```json
{"version":1,"scheme":"x25519-aes-256-gcm-v1","ephemeral_public_key":"…","ephemeral_key_signature":"…",
 "sender_ed25519_public_key":"…","nonce":"…","ciphertext":"…","authentication_tag":"…"}
```

On open: a present but invalid signature rejects the envelope; a valid one yields the **verified sender**
(hex sending key), which every group rule below checks. The field set and the signatures were checked against
300 real envelopes on `wss://nostr.onym.app`.

## 4. The Nostr courier (`onym:message-implementation:nostr-courier-v1`, `UI-Message-Nostr.md`)

- **Event**: kind **34113**, content = base64 of the sealed envelope, tags:
  `["d","sep-inbox:<tag>"]`, `["t","<tag>"]`, `["sep_inbox","<tag>"]`, `["sep_version","1"]`, `["ms","<unix ms>"]`.
- **Every event is signed by a fresh BIP-340 key** (never the identity's nostr key).
- **Subscription**: one `REQ` with three filters — `{kinds:[34113], "#d":["sep-inbox:<tag>"]}`,
  `{kinds:[34113], "#t":["<tag>"]}`, `{kinds:[24113], "#t":["<tag>"]}` (legacy kind, receive only).
- **Validation** of every event: exact shape, canonical id, BIP-340 signature, allowed kind, addressed to the
  requested tag, strict base64. Do not trust the relay to have filtered.
- **Event id quirk**: the apps hash the serialization with `/` escaped as `\/` (Foundation `JSONSerialization`,
  `org.json`); NIP-01 does not. Accept an id that matches either form.
- **Replays**: relays replay the whole inbox on every connection (no cursor). Buffer the first burst, apply it in
  `ms` order (invitations before their groups' messages), and remember processed event ids — but only for
  envelopes that opened, so junk addressed to a public tag cannot push real ids out.
- **Publishing** reports `accepted` / `rejected` / `unreachable` / `unknown` per relay; never read silence as
  success. A send succeeds if at least one relay accepted.
- Default relay: `wss://nostr.onym.app`. TLS only.

## 5. Payloads

Decode in the apps' order (`IncomingMessageDispatcher`): the payload is the **first** type whose required
fields all decode. Discriminating field in brackets.

| Type | [field] | Content |
|---|---|---|
| Invite offer | `offer_version` | `intro_pub` (32), `group_id` (32), `group_name`?, `inviter_alias`, `invitation_message`? |
| Refresh request | `refresh_version` | `refresh_group_id` (32), `requester_inbox_pub` (32), `requester_bls_pub` (48) — addressed to the admin |
| Member announcement | `new_member` | `version`, `group_id`, `new_member{bls_pub, inbox_pub, alias, sending_pub, rules_hash?, rules_signature?, rules_text?}`, `admin_alias`, `commitment`?, `epoch`? |
| Avatar change | `avatar_version` | `avatar_group_id`, `avatar_sender_bls_hex`, `avatar_sent_at_millis`, `avatar`? (JPEG base64) |
| Name change | `name_version` | `name_group_id`, `name_sender_bls_hex`, `name_sent_at_millis`, `name_value` |
| Invitation | `group_secret` | see below |
| Receipt | `message_ids` | `version`, `group_id`, `sender_bls_pubkey_hex`, `kind` (`delivered`/`read`), `message_ids` (uppercase UUIDs) |
| Chat message | `message_id` | `version`, `message_id` (uppercase UUID), `group_id`, `sender_bls_pubkey_hex`, `sent_at_millis`, `reply_to_message_id`?, `variant{kind:"tyranny", body}`, `attachment`? |

**Invitation**: `version`, `group_id`, `group_secret`, `name`, `members[{public_key_compressed, leaf_hash}]`,
`epoch`, `salt`, `commitment`?, `tier_raw`, `group_type_raw` (`"tyranny"`), `admin_pubkey_hex`?,
`member_profiles{<bls hex>: {alias, inbox_public_key, sending_pubkey, rules_hash?, rules_signature?, rules_text?}}`,
`avatar`?, `invitation_message`? (the group's rules text).

**Join request** (sealed to the offer's `intro_pub`, published to that key's inbox tag): `joiner_inbox_pub`,
`joiner_bls_pub`, `joiner_leaf_hash`, `joiner_sending_pub`, `joiner_display_label`, `group_id`,
`rules_hash`?, `rules_signature`?. The rules agreement is Ed25519 by the joiner's sending key over
`"onym-group-rules-v1" ‖ group_id ‖ SHA-256(trimmed rules) ‖ joiner sending public key`; "trimmed" uses
Swift's whitespace-and-newlines set (`core/rules.ts`). Hash and signature travel together or not at all.

**Photo attachment** (`attachment`): `sha256` (lowercase hex of the encrypted blob), `mime_type`, `byte_size`
(of the **encrypted** blob), `width`, `height`, `enc_key` (32, base64), `blurhash`, `server`. **onym-android requires
`blurhash`**: always send one (4×3 components, reference encoder rounding — `core/blurhash.ts`).

**Album** (`attachments`, two or more items; the flat `attachment` / `video_attachment` stay empty and `body` is the
one caption): each item is `{"kind": "image", "image": {…photo attachment…}}` or `{"kind": "video", "video": {…}}`.
Onymgram shows an album as grouped Telegram messages, one per photo, taking consecutive message numbers; a video
item is not shown and leaves a note.

**Voice** (`voice_attachment`; never with a caption or in an album): `sha256`, `mime_type` `"audio/mp4"`,
`byte_size` (encrypted), `duration_seconds` (a double), `enc_key`, `waveform` (40 integers 0…255: RMS per bucket
normalized to the loudest, `ChatVoiceEncoder`), `server`. The clip is **AAC in an MPEG-4 file** (`.m4a`), which the
iOS app plays with `AVAudioPlayer` and Android records with `MediaRecorder` (MPEG_4/AAC). A browser records it with
WebCodecs `AudioEncoder` (`mp4a.40.2`) and writes the file itself with the index ahead of the data
(`src/util/voiceRecording/m4aAacWriter.ts`); check a file with `afinfo` / `afconvert`, which use the same AudioToolbox.

Video (`video_attachment`: a poster image plus the video blob) is not supported here yet.

Conventions: padded standard base64 for bytes, uppercase UUIDs, lowercase hex for BLS keys.

## 6. What a member does

- **Offer** → show it with Join / Decline. **Join** sends the join request (signing the rules if present) to the
  intro key's inbox. A pasted join link creates the same offer locally.
- **Invitation** is accepted only if: `group_type_raw == "tyranny"`; the envelope is signed; the member list
  contains our BLS key; for a known group, the signer is the same admin sending key; the tier is 0/1/2
  (depth 5/8/11); the roster reproduces its own `commitment` (§7); the epoch does not go back. The apps also
  compare the commitment with the chain — Onymgram does not yet (see groups-admin.md §6).
- **Announcement, name, avatar** are accepted only from the admin's sending key (the signer of the invitation).
- **Chat message** is accepted only if the envelope signer is the sending key the roster lists for
  `sender_bls_pubkey_hex`, the variant is `tyranny`, and the id is new. Messages that arrive before their
  group's invitation wait (parked) and are replayed after it.
- **Receipts**: send `delivered` when a message is stored, `read` when it is seen, each to the message's sender.
  "Send read receipts" off (as in the app) sends no `read` receipts **and** ignores others'.
- **Sending** seals the chat message separately to every other member's `inbox_public_key` and publishes each
  to that member's inbox tag.
- **Refresh requests** are the admin's to answer; a member ignores them.

## 7. Poseidon and commitments (`core/poseidon.ts`)

Poseidon over BLS12-381 Fr as onym-contracts `plonk/prover/src/circuit/plonk/poseidon.rs` defines it: width 3
(rate 2, capacity 1), 8 full rounds (4 + 4) around 56 partial, S-box x⁵, Cauchy MDS `1/(i+j+5)`, round constants
SHA-256-chained from the seed `"SEP-XXXX-Poseidon-BLS12-381-w3-f8-p56-a5-round-constants"` (read little-endian
mod r), driven as the arkworks 0.5 sponge.

```
leaf       = H1(bls secret)                       (the joiner's leaf_hash)
root       = Merkle root over leaves sorted by compressed BLS public key, zero-padded to 2^depth, heap order
commitment = H2(H2(root, epoch), salt)            salt read little-endian mod r
admin_pubkey_commitment = H2(H1(admin bls secret), group_id_fr)
```

Tier → depth: 0 → 5 (32 members), 1 → 8, 2 → 11. The apps create tier 0.
Vector (onym-contracts `build_canonical_membership_witness(5)`, pinned in `core/poseidon.test.ts`): leaves
`H1(1..8)`, depth 5, epoch 1234, salt 32 × `0xee` → `66d6ca2b0096160993f6ffc7d93ef2d0ef617a0b5c2b6501ac55ff4891ee78be`.

## 8. Photos on Blossom (`core/blossom.ts`, `photo.ts`)

- Blob = `nonce(12) ‖ AES-256-GCM ciphertext ‖ tag`, random 32-byte key; addressed by SHA-256 of the blob.
- Upload: `PUT <server>/upload` with `Authorization: Nostr <base64(event)>`, a BUD-01 event of kind **24242**
  signed by a **fresh key**, tags `t=upload`, `x=<sha256>`, `expiration=<now+300>`, `ms`, content
  `"Upload chat image"`.
- Download `GET <server>/<sha256>` only from the user's own server list, whatever `server` the message names
  (onym-ios `BlossomServerStampPolicy`); check the hash format before building the URL, cap the size, check
  SHA-256 of the body, refuse redirects. Default server: `https://blossom.onym.app`.
