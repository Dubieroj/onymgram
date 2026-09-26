# Onym in a Telegram frontend: what this port learned

Onymgram runs Telegram Web A on the Onym network. These notes are for anyone taking the same step with
another Telegram client — Telegram Desktop, Telegram for Android, Telegram for iOS — or writing any new
Onym interface. They record what is verified against the Onym apps and the live network, the exact bytes
on the wire, and what is still missing, so the next port starts from facts instead of from zero.

| Document | Read it for |
|---|---|
| [protocol.md](protocol.md) | Identity, envelopes, the Nostr courier, every payload a member sends or receives, Poseidon, Blossom photos, links. Everything here is implemented in `src/api/onym/` and checked against the apps |
| [groups-admin.md](groups-admin.md) | The admin side the apps have and Onymgram does not yet: creating a group, inviting by inbox key, approving a join, anchoring on Stellar with a TurboPlonk proof, refresh requests |
| [porting.md](porting.md) | How a Telegram client is put on Onym: where to cut, how Onym maps onto Telegram's objects, what to hide, what the interface owes the user, how to verify, and the mistakes already made once |

## Sources

Everything cites the public Onym repositories at these commits (paths below are relative to each repo):

| Repository | Commit | What it is |
|---|---|---|
| [onymchat/onym-ios](https://github.com/onymchat/onym-ios) | `4e7f60b` (2026-09-12) | The iOS app: the reference behavior for every payload |
| [onymchat/onym-android](https://github.com/onymchat/onym-android) | `b5d21e7` (2026-09-12) | The Android app: same protocol, Kotlin |
| [onymchat/onym-contracts](https://github.com/onymchat/onym-contracts) | `42d2021` (tag v0.0.13) | Soroban contracts, circuits, the Rust prover and its C ABI |
| [onymchat/onym-relayer](https://github.com/onymchat/onym-relayer) | `be8cb0c` | The service that submits contract calls for the apps |
| [onymchat/onym-system](https://github.com/onymchat/onym-system) | `3dd6b6f` | The seat contracts: `interface/Interface.md`, `message/UI-Message-Nostr.md`, `notary/UI-Notary-Stellar.md` |
| [onymchat/onym-sdk-swift](https://github.com/onymchat/onym-sdk-swift), [onym-sdk-kotlin](https://github.com/onymchat/onym-sdk-kotlin) | 0.0.2 | Prebuilt prover SDKs the apps link (xcframework, AAR with JNI) |

Onymgram itself was verified with the Onym iOS app on 25 September 2026: the app created a group, invited
Onymgram by its inbox key, approved the join request, and messages went both ways over `wss://nostr.onym.app`.
Photos, albums, voice messages and receipts were verified against `dev/onym/simulate-admin.ts`, which writes
the apps' formats and, with `--save-media`, fetches and decrypts what Onymgram sends as the apps do; the files open
with Apple's ImageIO and AudioToolbox, the decoders behind the iOS app's `UIImage` and `AVAudioPlayer`.
