# Onymgram

An independent [Onym](https://onym.foundation) interface built on
[Telegram Web A](https://github.com/Ajaxy/telegram-tt): Telegram's web client with
MTProto taken out and the Onym network's own protocols put in its place. It fills the
**Interface** seat of the Onym system
([`interface/Interface.md`](https://github.com/onymchat/onym-system/blob/main/interface/Interface.md)):
a window onto the network that holds no accounts and can be replaced without asking anyone.

It speaks to the same relays, in the formats the Onym iOS and Android apps use, so a user of this
interface sits in the same group chat as users of the apps.

Forked from `telegram-tt` at
[`ea0d226`](https://github.com/Ajaxy/telegram-tt/commit/ea0d226147a80f05253bf1a6ffef08d694b8e6e4)
(22 September 2026). The upstream README is kept as [`README.telegram-web-a.md`](README.telegram-web-a.md).

## What changed, in one picture

```
Telegram Web A UI  ──callApi('fetchChats' | 'sendMessage' | …)──►  API web worker
   (unchanged                                                       ├─ before: GramJS → MTProto → Telegram's servers
    components)   ◄──────────── ApiUpdate stream ──────────────────  └─ now:    src/api/onym → Onym protocols
                                                                              ├─ identity: BIP-39 → Nostr / BLS12-381 / Ed25519 / X25519 keys
                                                                              ├─ sealed envelope: X25519 + HKDF + AES-256-GCM, Ed25519-signed
                                                                              ├─ courier: Nostr kind 34113 inboxes, fresh key per event
                                                                              ├─ groups: Tyranny rosters, Poseidon/Merkle commitment check
                                                                              └─ media: encrypted blobs on Blossom
```

The UI calls the worker by method name and receives plain `Api*` objects, so the whole
Telegram interface runs on the Onym network with the MTProto layer swapped out underneath.
Methods Onym has no counterpart for (stickers, stories, payments, calls…) answer `undefined`,
which the UI already treats as "not available".

| Onym | How it looks here |
|---|---|
| A BIP-39 phrase is the identity | Sign-in screen: create twelve words or enter yours; no phone, no email |
| Your inbox key | Settings → Onym identity: the key to paste into the app's *Invite by Inbox Key*, and a QR code of `https://onym.app/i?k=…` for its scanner |
| A Founder (Tyranny) group | A Telegram group; the admin shows as *Owner* |
| A member's self-chosen alias | A user; the card says the name is not verified |
| Invitations, join requests, status | The **Onymgram** service chat, with Join / Decline buttons |
| Delivered / read receipts | One or two ticks; Settings → Data turns read receipts off both ways, as the app does |
| An encrypted Blossom image | A photo |
| Nostr relays, Blossom servers | Settings → Transport: Onym's own servers, labelled as defaults, in lists you can replace |
| No direct messages | A member's chat shows who they are, with a note in place of the composer |

## Protocol support

Written to the formats of `onym-ios` (`4e7f60b`) and `onym-android` (`b5d21e7`). Checked with the Onym app
itself on 25 September 2026: the app created a group, invited this interface by its inbox key, approved the
join request, and messages went both ways over `wss://nostr.onym.app`. The admin-side simulator
([below](#exercise-it-against-the-real-network)) repeats that path, plus a photo through Blossom.

- **Identity**: every key the apps derive from a phrase, pinned to the apps' own cross-platform
  fixture (`abandon … about` → `GB5DHQE43…YJ7A`, inbox tag `f462ae97384bd242`).
- **Courier**: `onym:message-implementation:nostr-courier-v1` inbox events — the four tags, the three
  filters, a fresh BIP-340 key per event, full id and Schnorr checks on receipt, relay `OK` outcomes
  (`accepted` / `rejected` / `unreachable` / `unknown`, never silence read as success).
- **Envelope** `x25519-aes-256-gcm-v1`: seal and open, the sender's Ed25519 signature required for any
  chat message. The field set and sender signatures match 300 real envelopes on `wss://nostr.onym.app`.
- **Payloads**: group invite offers, join requests (with the rules agreement signature), invitations,
  member announcements, name and avatar changes, chat messages, receipts — decoded in the apps' order,
  accepting iOS's omitted and Android's `null` optionals.
- **Poseidon** over BLS12-381 Fr as onym-contracts defines it, reproducing the contracts' canonical
  depth-5 commitment `66d6ca2b…78be`: a joiner's leaf hash, and a check that an invitation's roster
  produces the commitment it claims.
- **Media**: Blossom blobs fetched only from the interface's own servers, checked against their SHA-256
  address, then decrypted.

## Honest limits

- **Joins and chats; does not create groups yet.** Creating a group or approving a join anchors the new
  roster on Stellar with a TurboPlonk proof. That needs the onym-contracts prover compiled to WebAssembly
  and a relayer this browser can reach (the default one sends no CORS headers and wants a token the apps
  are built with). Until then, someone with the Onym app creates the group and invites you.
- **The chain anchor is not checked.** An invitation must be signed by its admin and its roster must
  reproduce its own commitment, but the commitment is not compared with the Stellar contract. The group
  info panel says so.
- **Text and photos only.** Video, voice and albums are not sent; received ones show as a placeholder.
- **Only what Onym carries is offered.** Calls, channels, contacts, forwarding, editing, deleting, pinning
  and reports are hidden. A mute stays in this browser, and clearing the message cache deletes messages
  here only.
- **Browser storage.** Identity and chats are AES-GCM-sealed in IndexedDB under a non-extractable key that
  this browser generated, and Telegram Web A's own plaintext state cache is switched off. That keeps them
  from casual reading of the disk, not from code running in the page.
- **Not audited.** Like the Onym apps, this is alpha software.

## Run it

Node 24+ and npm 11:

```sh
npm ci
npm run dev                                  # → http://localhost:1234
npx vitest run -c vitest.onym.config.ts      # the protocol core: fixtures, vectors, envelopes
npm run check:ts
```

npm 11.11 can refuse the upstream `.npmrc` on a clean install (`EALLOWGIT` for `opus-recorder`, then
"`--min-release-age` cannot be provided when using `--before`"). Installing from the lockfile with that file
set aside works: `mv .npmrc .npmrc.off && npm ci; mv .npmrc.off .npmrc` (git dependencies are fetched over
HTTPS if SSH to GitHub is not set up: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
GIT_CONFIG_VALUE_0=ssh://git@github.com/`).

### Exercise it against the real network

`dev/onym/simulate-admin.ts` plays the Onym app's admin side, in the apps' formats, against the live
relay: it sends you an invitation, answers your join request with an invitation, writes to you, and
(with `--photo`) uploads an encrypted image to Blossom and sends it.

```sh
npx tsx dev/onym/simulate-admin.ts 'https://onym.app/i?k=…' --photo some.jpg
```

Copy the link from Settings → Onym identity, press **Join** in the Onymgram chat, reply in the group.

## Where things are

| Path | What it is |
|---|---|
| `src/api/onym/core/` | The protocol, independent of Telegram: `bip39`, `identity`, `envelope`, `nostr`, `relayPool`, `payloads`, `links`, `rules`, `poseidon`, `blossom`, and their tests |
| `src/api/onym/messenger.ts` | The Onym messenger state machine: offers, joins, invitations, announcements, messages, receipts |
| `src/api/onym/telegram.ts`, `methods/` | The mapping to Telegram's `Api*` objects and `callApi` methods |
| `src/api/onym/worker.ts`, `init.ts` | The worker the UI now starts in place of GramJS's |
| `src/components/auth/AuthOnym.tsx` | Sign-in with a phrase |
| `src/api/onym/settings.ts` | Relay and server lists, read receipts, mutes, sealed with the rest |
| `src/components/left/settings/SettingsOnym.tsx` | Invite link and QR, recovery phrase, keys |
| `src/components/left/settings/SettingsOnymServers.tsx` | The relay and Blossom server lists |
| `dev/onym/simulate-admin.ts` | The admin-side simulator above |
| `docs/onym/` | For other ports and interfaces: the protocol as verified here, the admin side still to build, and how a Telegram client is put on Onym |

## License

GPL-3.0-or-later, as Telegram Web A. See [LICENSE](LICENSE).
