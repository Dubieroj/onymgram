# Putting a Telegram client on Onym

How Onymgram did it for Telegram Web A, and what carries over to Telegram Desktop, Telegram for Android and
Telegram for iOS.

## 1. Where to cut

Keep Telegram's interface; replace what it talks to. Every Telegram client has one boundary where the UI asks
the network for something and gets Telegram objects and updates back. Put an **Onym backend** there: it keeps
the Onym state, speaks the protocol ([protocol.md](protocol.md)), and answers the UI with synthesized Telegram
objects. Anything Onym has no counterpart for answers "not available", which every Telegram client already
handles.

| Client | Boundary |
|---|---|
| Telegram Web A (done) | The GramJS web worker: `callApi(name, …args)` and `ApiUpdate`s. Replaced by `src/api/onym/worker.ts`; methods live in `src/api/onym/methods/`, missing ones answer `undefined` |
| Telegram Desktop (C++/Qt) | Requests go through `MTP::Instance` / `MTP::Sender` (`Telegram/SourceFiles/mtproto/`) and `ApiWrap`; results are generated TL types (`MTPUser`, `MTPChat`, `MTPMessage`, `MTPUpdates`) fed into `Data::Session`. Answer the requests the UI makes with TL objects built from Onym state |
| Telegram for Android (Java) | `ConnectionsManager.sendRequest(TLObject, RequestDelegate)` in front of the native `tgnet`; updates enter through `MessagesController.processUpdates(TLRPC.Updates)`; storage is `MessagesStorage` (SQLite) |
| Telegram for iOS (Swift) | `TelegramCore`: `Network.request(Api.functions.…)` over MtProtoKit, updates through the account state manager, storage in Postbox |

These are the places to start reading, not verified designs: confirm in the code before building on them.
Cut below the UI and above the transport, so no MTProto connection is ever opened.

## 2. How Onym maps onto Telegram (`src/api/onym/telegram.ts`, `ids.ts`)

| Onym | Telegram |
|---|---|
| The identity (12 words) | The signed-in user. Sign-in = create twelve words (the user confirms writing them down) or enter them, then a name. No phone, no code |
| A Tyranny ("Founder") group | A basic group, id `-((first 8 bytes of SHA-256("group:" + group id hex), big-endian) mod 2^39 + 1)`. The admin shows as Owner |
| A member | A user, id `(first 8 bytes of SHA-256("user:" + BLS key hex), big-endian) mod 2^48 + 1`. The name is self-chosen: say so on the profile |
| A chat message | A message with a per-group sequential id. Ids are never reused, even after the local cache is cleared; pending local messages get fractional ids |
| Delivered / read receipts | Outgoing ticks from the group's outbox read state |
| The interface's own notices | Telegram's service chat (777000), here named "Onymgram": a welcome with the inbox key and link, offers with **Join / Decline** inline buttons, join status. It accepts a pasted join link and answers other text with help |
| A photo | A photo message whose media the backend fetches from Blossom and decrypts |
| A member's private chat | Unlisted and read-only, with a note that Onym has no direct messages |

## 3. What to hide

Anything that would reach Telegram or has nothing behind it on Onym: channels, direct messages, contacts and
phone numbers, calls and voice chats, stories, bots and mini apps, stickers/GIF search, payments, premium,
folders sync, forwarding, editing, deleting and pinning messages (Onym carries none of these), reports,
auto-delete timers, "seen by", blocking, sharing controls, leaving/deleting chats (not implemented), the
new-chat button (until group creation works), Telegram's FAQ/support/privacy links, web sync and update checks.
Keep: search in chat (local), mute (local), select and copy, reply, night mode, text size, animations.
In Web A these are gated by one constant, `HAS_TELEGRAM_SERVICES = false` in `src/config.ts`.

## 4. What the interface owes the user

From `onym-system/interface/Interface.md` — check every release against it:

- **No account**: the phrase is the identity. The interface keeps nothing about the user on any server.
- **Never contact Telegram.** Remove the API id/hash requirement, MTProto, analytics, web sync, update checks
  and every `t.me` path. Verify with the network log: only the relays, Blossom servers and (for admins) the
  chain services the user can see in Settings.
- **Local state encrypted at rest.** Web A seals IndexedDB entries with AES-GCM under a non-extractable key and
  switches off Telegram's plaintext global-state cache. Native clients: Keychain / Android Keystore-backed
  encryption for the database and caches, and the phrase shown only on explicit request.
- **Defaults labelled and replaceable in place**: relays (`wss://nostr.onym.app`), Blossom
  (`https://blossom.onym.app`), and for admins the Soroban RPC / manifest source. At least one of each stays.
- **Honest limits in the UI**, e.g. "the on-chain anchor is not checked by this interface" on the group info
  panel while that is true.
- A security review before each release.

Settings that match the Onym app: **Onym identity** (inbox key as 64-hex with Copy, QR of the identity link,
recovery phrase behind a reveal, public keys), **Transport** (relay list, Blossom list), **Data** (Send read
receipts — off also hides others' reads, as in the app; delivery receipts are always sent — and Clear Local
Message Cache, which keeps the chats and remembers the cleared ids so a relay cannot bring them back).

## 5. How to verify

1. **Vectors first**: identity fixture and Poseidon commitment (protocol.md §1, §7), the rules signature, join
   links, and envelope signatures from real traffic. Port `src/api/onym/core/*.test.ts`.
2. **The admin simulator** from this repo plays an iOS-format admin on the live relay:
   `npx tsx dev/onym/simulate-admin.ts <64-hex inbox key or identity link> [--photo a.jpg] [--album a.jpg,b.jpg]
   [--voice clip.m4a] [--save-media dir] [--relay wss://…]`.
   Each run creates a new group, sends an offer, answers the join request with an invitation, writes a message
   (and a photo, an album, a voice clip), and sends a read receipt when you reply. `--save-media` fetches, checks
   and decrypts every photo and clip the interface sends, for `sips` / `afinfo` to open. It also replays older events the relay still holds,
   so only trust log lines after the point you care about.
3. **The real Onym app**: in the app, create a group and use *Invite by Inbox Key* with the 64-hex key; press
   Join; chat both ways; send photos both ways; check ticks. For group creation, reverse the roles: the app
   must show a group the new interface created (it will only if it is anchored, groups-admin.md §7).

## 6. Mistakes already made once

- The iOS app's inbox-key paste field accepts only the 64-hex key; the `https://onym.app/i?k=` link works only
  through its QR scanner.
- Event ids: accept both the NIP-01 hash and the one with `/` escaped as `\/`.
- Relays replay the whole inbox on every connection: order the first burst by the `ms` tag and remember
  processed ids — only for envelopes that opened.
- onym-android refuses image attachments without a BlurHash, and the encoder must round like the reference
  one (`Math.trunc(x + 0.5)`, largest signed AC value).
- The BLS secret is big-endian mod r; the salt is little-endian mod r; leaves are sorted by compressed BLS key
  before the root is built.
- Web A shows an endless spinner for a chat whose main-thread info it never received; send thread info with
  every chat. A member's private chat needs a chat object and thread info too.
- Web A crashes rendering messages when peer colors were never loaded; serve the classic seven.
- `updateChat.readState` does not move the ticks in Web A; send `updateThreadReadState`.
- Telegram's legacy UI strings come from its servers; bundle the ones your screens show, or users see raw keys.
- Settings must be loaded before anything may change them, or an early toggle saves defaults over the user's
  relay list.
- Blossom: check the hash before building a URL, download only from the user's list, refuse redirects.
- An unanchored group is invisible to the Onym apps; anchor on the latest manifest's Tyranny contract.
