import {
  fromBase64, fromHex, toBase64, toHex,
} from './bytes';

// Inner inbox payloads, byte-compatible with onym-ios / onym-android `Codable` / kotlinx types: `Data` is padded
// standard base64, UUIDs are uppercase, absent optionals may be omitted (iOS) or `null` (Android)

export type MemberProfile = {
  alias: string;
  inboxPublicKey: string;
  sendingPublicKey: string;
  rulesHash?: string;
  rulesSignature?: string;
  rulesText?: string;
};

export type GovernanceMember = {
  publicKey: string;
  leafHash: string;
};

export type GroupInviteOffer = {
  type: 'offer';
  introPublicKey: string;
  groupId: string;
  groupName?: string;
  inviterAlias: string;
  invitationMessage?: string;
};

export type GroupInvitation = {
  type: 'invitation';
  groupId: string;
  groupSecret: string;
  name: string;
  members: GovernanceMember[];
  epoch: bigint;
  salt: string;
  commitment?: string;
  tier: number;
  groupType: string;
  adminPublicKey?: string;
  memberProfiles: Record<string, MemberProfile>;
  avatar?: string;
  invitationMessage?: string;
};

export type MemberAnnouncement = {
  type: 'announcement';
  groupId: string;
  newMember: MemberProfile & { blsPublicKey: string };
  adminAlias: string;
  commitment?: string;
  epoch?: bigint;
};

export type GroupNameChange = {
  type: 'name';
  groupId: string;
  senderBlsPublicKey: string;
  sentAtMs: number;
  name: string;
};

export type GroupAvatarChange = {
  type: 'avatar';
  groupId: string;
  senderBlsPublicKey: string;
  sentAtMs: number;
  avatar?: string;
};

export type GroupStateRefresh = {
  type: 'refresh';
  groupId: string;
};

export type ChatReceipt = {
  type: 'receipt';
  groupId: string;
  senderBlsPublicKey: string;
  kind: 'delivered' | 'read';
  messageIds: string[];
};

export type ImageAttachment = {
  sha256: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  encryptionKey: string;
  blurhash?: string;
  server?: string;
};

// A voice clip: AAC in an MPEG-4 container (`audio/mp4`), as both apps record it, with a waveform of 40 values
// 0…255 drawn before the clip is downloaded
export type VoiceAttachment = {
  sha256: string;
  mimeType: string;
  byteSize: number;
  durationSeconds: number;
  encryptionKey: string;
  waveform: number[];
  server?: string;
};

export type ChatMessage = {
  type: 'message';
  messageId: string;
  groupId: string;
  senderBlsPublicKey: string;
  sentAtMs: number;
  replyToMessageId?: string;
  variantKind: string;
  body: string;
  image?: ImageAttachment;
  // The photos of an album (`attachments`, two or more items); its videos are not shown here
  images?: ImageAttachment[];
  voice?: VoiceAttachment;
  hasUnsupportedMedia?: boolean;
};

export type JoinRequest = {
  joinerInboxPublicKey: string;
  joinerBlsPublicKey: string;
  joinerLeafHash: string;
  joinerSendingPublicKey: string;
  joinerDisplayLabel: string;
  groupId: string;
  rulesHash?: string;
  rulesSignature?: string;
};

export type InboundPayload = GroupInviteOffer | GroupStateRefresh | MemberAnnouncement | GroupAvatarChange
  | GroupNameChange | GroupInvitation | ChatReceipt | ChatMessage;

type Json = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tried in the order the Onym apps try them (`IncomingMessageDispatcher`): a payload is the first type whose
// required fields all decode
export function decodeInboundPayload(plaintext: Uint8Array): InboundPayload | undefined {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return undefined;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;

  for (const decode of DECODERS) {
    try {
      const payload = decode(json as Json);
      if (payload) return payload;
    } catch {
      // Not this type; try the next one
    }
  }
  return undefined;
}

const DECODERS: ((json: Json) => InboundPayload | undefined)[] = [
  decodeOffer, decodeRefresh, decodeAnnouncement, decodeAvatar, decodeName, decodeInvitation, decodeReceipt,
  decodeChatMessage,
];

function decodeOffer(json: Json): GroupInviteOffer | undefined {
  if (!('offer_version' in json)) return undefined;
  integer(json.offer_version);
  return {
    type: 'offer',
    introPublicKey: bytes(json.intro_pub, 32),
    groupId: bytes(json.group_id, 32),
    groupName: optional(json.group_name, string),
    inviterAlias: string(json.inviter_alias),
    invitationMessage: optional(json.invitation_message, string),
  };
}

function decodeRefresh(json: Json): GroupStateRefresh | undefined {
  if (!('refresh_version' in json)) return undefined;
  integer(json.refresh_version);
  bytes(json.requester_inbox_pub, 32);
  bytes(json.requester_bls_pub);
  return { type: 'refresh', groupId: bytes(json.refresh_group_id, 32) };
}

function decodeAnnouncement(json: Json): MemberAnnouncement | undefined {
  if (!('new_member' in json)) return undefined;
  integer(json.version);
  const member = object(json.new_member);
  return {
    type: 'announcement',
    groupId: bytes(json.group_id, 32),
    newMember: {
      blsPublicKey: bytes(member.bls_pub, 48),
      ...decodeProfileFields(member, 'inbox_pub', 'sending_pub'),
    },
    adminAlias: string(json.admin_alias),
    commitment: optional(json.commitment, (value) => bytes(value, 32)),
    epoch: optional(json.epoch, bigInteger),
  };
}

function decodeAvatar(json: Json): GroupAvatarChange | undefined {
  if (!('avatar_version' in json)) return undefined;
  integer(json.avatar_version);
  return {
    type: 'avatar',
    groupId: bytes(json.avatar_group_id, 32),
    senderBlsPublicKey: blsHex(json.avatar_sender_bls_hex),
    sentAtMs: integer(json.avatar_sent_at_millis),
    avatar: optional(json.avatar, (value) => toBase64(fromBase64(string(value)))),
  };
}

function decodeName(json: Json): GroupNameChange | undefined {
  if (!('name_version' in json)) return undefined;
  integer(json.name_version);
  return {
    type: 'name',
    groupId: bytes(json.name_group_id, 32),
    senderBlsPublicKey: blsHex(json.name_sender_bls_hex),
    sentAtMs: integer(json.name_sent_at_millis),
    name: string(json.name_value),
  };
}

function decodeInvitation(json: Json): GroupInvitation | undefined {
  if (!('group_secret' in json)) return undefined;
  integer(json.version);
  const profiles = optional(json.member_profiles, object) || {};
  return {
    type: 'invitation',
    groupId: bytes(json.group_id, 32),
    groupSecret: bytes(json.group_secret),
    name: string(json.name),
    members: array(json.members).map((member) => {
      const entry = object(member);
      return { publicKey: bytes(entry.public_key_compressed), leafHash: bytes(entry.leaf_hash, 32) };
    }),
    epoch: bigInteger(json.epoch),
    salt: bytes(json.salt),
    commitment: optional(json.commitment, (value) => bytes(value, 32)),
    tier: integer(json.tier_raw),
    groupType: string(json.group_type_raw),
    adminPublicKey: optional(json.admin_pubkey_hex, (value) => string(value).toLowerCase()),
    memberProfiles: Object.fromEntries(Object.entries(profiles).map(([key, value]) => [
      key.toLowerCase(), decodeProfileFields(object(value), 'inbox_public_key', 'sending_pubkey'),
    ])),
    avatar: optional(json.avatar, (value) => toBase64(fromBase64(string(value)))),
    invitationMessage: optional(json.invitation_message, string),
  };
}

function decodeReceipt(json: Json): ChatReceipt | undefined {
  if (!('message_ids' in json)) return undefined;
  integer(json.version);
  const kind = string(json.kind);
  if (kind !== 'delivered' && kind !== 'read') return undefined;
  return {
    type: 'receipt',
    groupId: bytes(json.group_id, 32),
    senderBlsPublicKey: blsHex(json.sender_bls_pubkey_hex),
    kind,
    messageIds: array(json.message_ids).map(uuid),
  };
}

function decodeChatMessage(json: Json): ChatMessage | undefined {
  if (!('message_id' in json)) return undefined;
  integer(json.version);
  const variant = object(json.variant);
  const image = optional(json.attachment, decodeImage);
  const album = optional(json.attachments, array)?.map((item) => object(item));
  const images = album?.filter((item) => item.kind === 'image').map((item) => decodeImage(item.image));
  const voice = optional(json.voice_attachment, decodeVoice);
  const hasUnsupportedMedia = !isAbsent(json.video_attachment) || Boolean(album?.some((item) => item.kind !== 'image'));
  return {
    type: 'message',
    messageId: uuid(json.message_id),
    groupId: bytes(json.group_id, 32),
    senderBlsPublicKey: blsHex(json.sender_bls_pubkey_hex),
    sentAtMs: integer(json.sent_at_millis),
    replyToMessageId: optional(json.reply_to_message_id, uuid),
    variantKind: string(variant.kind),
    body: string(variant.body),
    image,
    images: images?.length ? images : undefined,
    voice,
    hasUnsupportedMedia: hasUnsupportedMedia || undefined,
  };
}

function decodeImage(value: unknown): ImageAttachment {
  const json = object(value);
  return {
    sha256: string(json.sha256).toLowerCase(),
    mimeType: string(json.mime_type),
    byteSize: integer(json.byte_size),
    width: integer(json.width),
    height: integer(json.height),
    encryptionKey: bytes(json.enc_key, 32),
    blurhash: optional(json.blurhash, string),
    server: optional(json.server, string),
  };
}

function decodeVoice(value: unknown): VoiceAttachment {
  const json = object(value);
  if (typeof json.duration_seconds !== 'number' || !Number.isFinite(json.duration_seconds)) {
    throw new Error('Expected duration');
  }
  return {
    sha256: string(json.sha256).toLowerCase(),
    mimeType: string(json.mime_type),
    byteSize: integer(json.byte_size),
    durationSeconds: Math.max(0, json.duration_seconds),
    encryptionKey: bytes(json.enc_key, 32),
    waveform: array(json.waveform).map((sample) => Math.max(0, Math.min(255, integer(sample)))),
    server: optional(json.server, string),
  };
}

function decodeProfileFields(json: Json, inboxKey: string, sendingKey: string): MemberProfile {
  const rulesHash = optional(json.rules_hash, (value) => bytes(value));
  const rulesSignature = optional(json.rules_signature, (value) => bytes(value));
  // A rules agreement is a hash and a signature together, or nothing (`MemberProfile.paired`)
  const isPaired = rulesHash?.length === 64 && rulesSignature?.length === 128;
  return {
    alias: string(json.alias),
    inboxPublicKey: bytes(json[inboxKey], 32),
    sendingPublicKey: bytes(json[sendingKey], 32),
    rulesHash: isPaired ? rulesHash : undefined,
    rulesSignature: isPaired ? rulesSignature : undefined,
    rulesText: isPaired ? optional(json.rules_text, string) : undefined,
  };
}

// Outbound

export function encodeChatMessage(message: Omit<ChatMessage, 'type' | 'variantKind' | 'hasUnsupportedMedia'>) {
  return encodeJson({
    version: 1,
    message_id: message.messageId.toUpperCase(),
    group_id: hexToBase64(message.groupId),
    sender_bls_pubkey_hex: message.senderBlsPublicKey.toLowerCase(),
    sent_at_millis: message.sentAtMs,
    reply_to_message_id: message.replyToMessageId?.toUpperCase(),
    variant: { kind: 'tyranny', body: message.body },
    attachment: message.image && encodeImage(message.image),
    // Two or more photos travel as an album; the flat single fields stay empty
    attachments: message.images?.map((image) => ({ kind: 'image', image: encodeImage(image) })),
    voice_attachment: message.voice && {
      sha256: message.voice.sha256,
      mime_type: message.voice.mimeType,
      byte_size: message.voice.byteSize,
      duration_seconds: message.voice.durationSeconds,
      enc_key: hexToBase64(message.voice.encryptionKey),
      waveform: message.voice.waveform,
      server: message.voice.server,
    },
  });
}

function encodeImage(image: ImageAttachment) {
  return {
    sha256: image.sha256,
    mime_type: image.mimeType,
    byte_size: image.byteSize,
    width: image.width,
    height: image.height,
    enc_key: hexToBase64(image.encryptionKey),
    blurhash: image.blurhash,
    server: image.server,
  };
}

export function encodeReceipt(receipt: Omit<ChatReceipt, 'type'>) {
  return encodeJson({
    version: 1,
    group_id: hexToBase64(receipt.groupId),
    sender_bls_pubkey_hex: receipt.senderBlsPublicKey.toLowerCase(),
    kind: receipt.kind,
    message_ids: receipt.messageIds.map((id) => id.toUpperCase()),
  });
}

export function encodeJoinRequest(request: JoinRequest) {
  return encodeJson({
    joiner_inbox_pub: hexToBase64(request.joinerInboxPublicKey),
    joiner_bls_pub: hexToBase64(request.joinerBlsPublicKey),
    joiner_leaf_hash: hexToBase64(request.joinerLeafHash),
    joiner_sending_pub: hexToBase64(request.joinerSendingPublicKey),
    joiner_display_label: request.joinerDisplayLabel,
    group_id: hexToBase64(request.groupId),
    rules_hash: request.rulesHash && hexToBase64(request.rulesHash),
    rules_signature: request.rulesSignature && hexToBase64(request.rulesSignature),
  });
}

function encodeJson(value: Json) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function hexToBase64(hex: string) {
  return toBase64(fromHex(hex));
}

// Field readers: each throws on a type mismatch, like a failing `Codable` decode

function string(value: unknown) {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}

function integer(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Expected integer');
  return value;
}

function bigInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('Expected unsigned integer');
  return BigInt(value);
}

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Json;
}

function array(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value as unknown[];
}

function bytes(value: unknown, length?: number) {
  const decoded = fromBase64(string(value));
  if (length !== undefined && decoded.length !== length) throw new Error(`Expected ${length} bytes`);
  return toHex(decoded);
}

function uuid(value: unknown) {
  const text = string(value);
  if (!UUID_RE.test(text)) throw new Error('Expected UUID');
  return text.toUpperCase();
}

function blsHex(value: unknown) {
  const text = string(value).toLowerCase();
  if (!/^[0-9a-f]{96}$/.test(text)) throw new Error('Expected BLS public key hex');
  return text;
}

function optional<T>(value: unknown, read: (value: unknown) => T): T | undefined {
  return isAbsent(value) ? undefined : read(value);
}

// Absent optionals arrive omitted (iOS) or as JSON null (Android)
function isAbsent(value: unknown) {
  return (value ?? undefined) === undefined;
}
