import type { OpenedEnvelope } from './core/envelope';
import type { IdentityPublic, IdentitySecrets } from './core/identity';
import type {
  ChatMessage, ChatReceipt, GovernanceMember, GroupAvatarChange, GroupInvitation, GroupInviteOffer, GroupNameChange,
  ImageAttachment, MemberAnnouncement, MemberProfile, VoiceAttachment,
} from './core/payloads';
import type { Inbound, RelayPool } from './core/relayPool';

import { fromHex, toHex } from './core/bytes';
import { openEnvelope, sealEnvelope } from './core/envelope';
import { getInboxTag } from './core/identity';
import { buildIdentityLink } from './core/links';
import { buildInboxEvent, getEventTimeMs } from './core/nostr';
import {
  decodeInboundPayload, encodeChatMessage, encodeJoinRequest, encodeReceipt,
} from './core/payloads';
import { computeCommitment, computeLeafHash, computeMerkleRoot } from './core/poseidon';
import { normalizeRules, signRulesAgreement } from './core/rules';
import { readSealed, writeSealed } from './store';

// The Onym messenger protocol as the apps speak it (onym-ios `IncomingMessageDispatcher`, `SendMessageInteractor`,
// `JoinRequestSender`): every payload is sealed per recipient and published to that recipient's inbox; groups are
// Tyranny ("Founder") groups whose admin anchors membership on Stellar, which a joiner never has to do
const STATE_ENTRY = 'messenger';
const SAVE_DELAY_MS = 400;
const REPLAY_SETTLE_MS = 4000;
const PROCESSED_EVENTS_LIMIT = 5000;
const PARKED_LIMIT = 500;
const TIER_DEPTHS: Record<number, number> = { 0: 5, 1: 8, 2: 11 };
const SUPPORTED_GROUP_TYPE = 'tyranny';

export type Group = {
  id: string;
  name: string;
  groupSecret: string;
  members: GovernanceMember[];
  memberProfiles: Record<string, MemberProfile>;
  epoch: string;
  salt: string;
  commitment?: string;
  tier: number;
  adminPublicKey?: string;
  adminSendingKey: string;
  avatar?: string;
  invitationMessage?: string;
  joinedAt: number;
  // The invitation's commitment recomputed from its own roster; the on-chain check is not made here yet
  isCommitmentConsistent?: boolean;
  lastReadInboxSeq: number;
  lastReadOutboxSeq: number;
  // Highest message number handed out, kept when local messages are cleared so numbers never repeat
  lastSeq?: number;
};

export type Offer = {
  groupId: string;
  introPublicKey: string;
  groupName?: string;
  inviterAlias?: string;
  rules?: string;
  receivedAt: number;
  status: 'pending' | 'requested' | 'declined';
  noticeSeq?: number;
};

export type Message = {
  seq: number;
  logicalId: string;
  groupId: string;
  senderBls: string;
  sentAtMs: number;
  text: string;
  replyTo?: string;
  isOutgoing: boolean;
  status?: 'pending' | 'sent' | 'failed' | 'delivered' | 'read';
  image?: ImageAttachment;
  // An album; its photos take consecutive message numbers, one each, as Telegram shows an album
  images?: ImageAttachment[];
  voice?: VoiceAttachment;
  hasUnsupportedMedia?: boolean;
};

export type OutgoingContent = {
  text: string;
  replyTo?: string;
  image?: ImageAttachment;
  images?: ImageAttachment[];
  voice?: VoiceAttachment;
};

// How many message numbers a message takes: one, or one per photo of an album
export function getMessageSpan(message: Pick<Message, 'images'>) {
  return message.images?.length || 1;
}

export type Notice = {
  seq: number;
  dateMs: number;
  text: string;
  offerGroupId?: string;
  isOutgoing?: boolean;
};

type Parked = { plaintext: string; verifiedSender?: string; eventTimeMs: number };

type State = {
  groups: Record<string, Group>;
  offers: Record<string, Offer>;
  messages: Record<string, Message[]>;
  notices: Notice[];
  parked: Record<string, Parked[]>;
  processedEvents: string[];
  // Ids of the group messages the user cleared, kept so that a relay still holding them cannot bring them back
  cleared?: Record<string, string[]>;
  lastReadNoticeSeq?: number;
  hasWelcomed?: boolean;
};

export type MessengerListener = {
  onGroup: (group: Group, isNew: boolean) => void;
  onMessage: (message: Message, isNew: boolean) => void;
  onMessagesCleared: (groupId: string, seqs: number[]) => void;
  onNotice: (notice: Notice, isNew: boolean) => void;
  onOffer: (offer: Offer) => void;
};

export class Messenger {
  private state: State = {
    groups: {}, offers: {}, messages: {}, notices: [], parked: {}, processedEvents: [],
  };

  private processed = new Set<string>();

  private queue: Promise<void> = Promise.resolve();

  private replayBuffer: Inbound[] | undefined = [];

  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private secrets: IdentitySecrets,
    private me: IdentityPublic,
    private displayName: () => string,
    private sendsReadReceipts: () => boolean,
    private pool: RelayPool,
    private listener: MessengerListener,
  ) {}

  async load() {
    const stored = await readSealed<State>(STATE_ENTRY);
    if (stored) this.state = { ...this.state, ...stored };
    this.processed = new Set(this.state.processedEvents);

    if (!this.state.hasWelcomed) {
      this.state.hasWelcomed = true;
      this.addNotice([
        'This is your Onym identity, kept encrypted in this browser.',
        '',
        `Your inbox key: ${this.me.inboxPublicKey}`,
        `As a link: ${buildIdentityLink(this.me.inboxPublicKey)}`,
        '',
        'Give it to someone who uses Onym: they add you to a chat in Create group, Invite by Inbox Key. '
        + 'To join a group yourself, paste its join link (https://onym.app/join?c=…) here.',
      ].join('\n'));
    }
  }

  start() {
    // Relays replay the whole inbox on every connection (no cursor in the profile): the first burst is buffered and
    // applied in event-time order, so invitations land before the messages of their groups
    this.pool.subscribe('inbox', this.me.inboxTag, (inbound) => {
      if (this.replayBuffer) {
        this.replayBuffer.push(inbound);
      } else {
        this.enqueue(inbound);
      }
    }, () => this.flushReplay());
    setTimeout(() => this.flushReplay(), REPLAY_SETTLE_MS);
  }

  getState() {
    return this.state;
  }

  getGroup(groupId: string) {
    return this.state.groups[groupId];
  }

  getMessages(groupId: string) {
    return this.state.messages[groupId] || [];
  }

  // Joining: from a push offer, or from a join link pasted by the user
  addOfferFromLink(capability: { introPublicKey: string; groupId: string; groupName?: string; rules?: string }) {
    if (this.state.groups[capability.groupId]) {
      this.addNotice(`You are already a member of “${this.state.groups[capability.groupId].name}”.`);
      return;
    }
    this.recordOffer({
      groupId: capability.groupId,
      introPublicKey: capability.introPublicKey,
      groupName: capability.groupName,
      rules: normalizeRules(capability.rules),
      receivedAt: Date.now(),
      status: 'pending',
    });
  }

  async acceptOffer(groupId: string) {
    const offer = this.state.offers[groupId];
    if (!offer || offer.status === 'declined') return 'This invitation is no longer open.';
    if (this.state.groups[groupId]) return 'You are already a member.';

    const request = {
      joinerInboxPublicKey: this.me.inboxPublicKey,
      joinerBlsPublicKey: this.me.blsPublicKey,
      joinerLeafHash: toHex(computeLeafHash(this.secrets.blsSecretKey)),
      joinerSendingPublicKey: this.me.sendingPublicKey,
      joinerDisplayLabel: this.displayName(),
      groupId,
      ...(offer.rules ? signRulesAgreement(offer.rules, groupId, this.secrets.sendingSeed) : undefined),
    };
    const introPublicKey = fromHex(offer.introPublicKey);
    const sealed = await sealEnvelope(encodeJoinRequest(request), introPublicKey, this.secrets.sendingSeed);
    const result = await this.pool.publish(buildInboxEvent(getInboxTag(introPublicKey), sealed));
    if (!Object.values(result.outcomes).some(({ outcome }) => outcome === 'accepted')) {
      return 'No relay accepted the join request. Check the connection and try again.';
    }

    this.updateOffer({ ...offer, status: 'requested' });
    this.addNotice(`Join request sent for “${offer.groupName || 'the group'}”. `
      + 'The chat appears here once its admin approves it in their app.');
    return 'Join request sent';
  }

  declineOffer(groupId: string) {
    const offer = this.state.offers[groupId];
    if (!offer) return;
    // Declining leaves no protocol trace: nothing is sent to the inviter (Interface.md §7.4)
    this.updateOffer({ ...offer, status: 'declined' });
  }

  markNoticesRead(maxSeq: number) {
    if (maxSeq <= (this.state.lastReadNoticeSeq || 0)) return;
    this.state.lastReadNoticeSeq = maxSeq;
    this.scheduleSave();
  }

  // Deletes every group message held here and keeps the chats. Their ids stay behind, so a relay that still holds
  // the messages cannot bring them back
  async clearMessages() {
    const clearedMessages = this.state.messages;
    this.state.messages = {};
    this.state.parked = {};
    Object.entries(clearedMessages).forEach(([groupId, messages]) => {
      const group = this.state.groups[groupId];
      const last = messages[messages.length - 1];
      if (group) group.lastSeq = Math.max(group.lastSeq || 0, last ? last.seq + getMessageSpan(last) - 1 : 0);
      this.state.cleared = {
        ...this.state.cleared,
        [groupId]: [...(this.state.cleared?.[groupId] || []), ...messages.map(({ logicalId }) => logicalId)],
      };
      this.listener.onMessagesCleared(groupId, messages.flatMap((message) => (
        Array.from({ length: getMessageSpan(message) }, (_, i) => message.seq + i)
      )));
    });
    await this.flush();
  }

  addOutgoingNotice(text: string) {
    return this.addNotice(text, undefined, true);
  }

  addNotice(text: string, offerGroupId?: string, isOutgoing?: boolean) {
    const notice: Notice = {
      seq: (this.state.notices[this.state.notices.length - 1]?.seq || 0) + 1,
      dateMs: Date.now(),
      text,
      offerGroupId,
      isOutgoing,
    };
    this.state.notices.push(notice);
    this.scheduleSave();
    this.listener.onNotice(notice, true);
    return notice;
  }

  async sendMessage(groupId: string, {
    text, replyTo, image, images, voice,
  }: OutgoingContent) {
    const group = this.state.groups[groupId];
    if (!group) throw new Error('Unknown group');

    const message = this.insertMessage({
      logicalId: crypto.randomUUID().toUpperCase(),
      groupId,
      senderBls: this.me.blsPublicKey,
      sentAtMs: Date.now(),
      text,
      replyTo,
      isOutgoing: true,
      status: 'pending',
      image,
      images,
      voice,
    });

    const payload = encodeChatMessage({
      messageId: message.logicalId,
      groupId,
      senderBlsPublicKey: this.me.blsPublicKey,
      sentAtMs: message.sentAtMs,
      replyToMessageId: replyTo,
      body: text,
      image,
      images,
      voice,
    });
    const outcomes = await this.sendToMembers(group, payload);
    this.updateMessage({ ...message, status: outcomes.every(Boolean) ? 'sent' : 'failed' });
    return this.findMessage(groupId, message.logicalId)!;
  }

  // Read receipts go to each sender whose messages the user has now seen, unless the user turned them off
  async markRead(groupId: string, maxSeq: number) {
    const group = this.state.groups[groupId];
    if (!group || maxSeq <= group.lastReadInboxSeq) return;

    const newlyRead = this.getMessages(groupId)
      .filter((message) => !message.isOutgoing && message.seq > group.lastReadInboxSeq && message.seq <= maxSeq);
    this.updateGroup({ ...group, lastReadInboxSeq: maxSeq });
    if (!this.sendsReadReceipts()) return;

    const bySender = new Map<string, string[]>();
    newlyRead.forEach((message) => {
      bySender.set(message.senderBls, [...(bySender.get(message.senderBls) || []), message.logicalId]);
    });
    await Promise.all([...bySender].map(([senderBls, messageIds]) => (
      this.sendReceipt(group, senderBls, 'read', messageIds)
    )));
  }

  private enqueue(inbound: Inbound) {
    this.queue = this.queue.then(() => this.handleInbound(inbound)).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[onym] inbound event failed', err);
    });
  }

  private flushReplay() {
    const buffered = this.replayBuffer;
    if (!buffered) return;
    this.replayBuffer = undefined;
    buffered
      .sort((a, b) => getEventTimeMs(a.event) - getEventTimeMs(b.event))
      .forEach((inbound) => this.enqueue(inbound));
  }

  private async handleInbound({ event, payload }: Inbound) {
    if (this.processed.has(event.id)) return;

    let opened: OpenedEnvelope;
    try {
      opened = await openEnvelope(payload, this.secrets.inboxSecretKey);
    } catch {
      return;
    }
    // Only an envelope that opens is remembered, so events anyone can publish to the inbox cannot push real ones out
    this.rememberProcessed(event.id);
    this.dispatch(opened.plaintext, opened.verifiedSender, getEventTimeMs(event));
  }

  private dispatch(plaintext: Uint8Array, verifiedSender: string | undefined, eventTimeMs: number) {
    const payload = decodeInboundPayload(plaintext);
    if (!payload) return;

    switch (payload.type) {
      case 'offer':
        this.handleOffer(payload, eventTimeMs);
        break;
      case 'invitation':
        this.handleInvitation(payload, verifiedSender);
        break;
      case 'announcement':
        this.handleAnnouncement(payload, verifiedSender);
        break;
      case 'name':
        this.handleName(payload, verifiedSender);
        break;
      case 'avatar':
        this.handleAvatar(payload, verifiedSender);
        break;
      case 'receipt':
        this.handleReceipt(payload, verifiedSender);
        break;
      case 'message':
        this.handleChatMessage(payload, plaintext, verifiedSender, eventTimeMs);
        break;
      default:
        // Group-state refresh requests are addressed to admins; this client does not administer groups yet
        break;
    }
  }

  private handleOffer(offer: GroupInviteOffer, eventTimeMs: number) {
    if (this.state.groups[offer.groupId]) return;
    const existing = this.state.offers[offer.groupId];
    if (existing && existing.status !== 'pending') return;

    this.recordOffer({
      groupId: offer.groupId,
      introPublicKey: offer.introPublicKey,
      groupName: offer.groupName,
      inviterAlias: offer.inviterAlias,
      rules: normalizeRules(offer.invitationMessage),
      receivedAt: eventTimeMs,
      status: 'pending',
      noticeSeq: existing?.noticeSeq,
    });
  }

  private recordOffer(offer: Offer) {
    const existing = this.state.offers[offer.groupId];
    if (existing?.noticeSeq && existing.status === 'pending' && existing.introPublicKey === offer.introPublicKey) {
      return;
    }

    const name = offer.groupName ? `“${offer.groupName}”` : 'a group';
    const lines = [
      offer.inviterAlias ? `${offer.inviterAlias} invites you to ${name}.` : `Invitation to ${name}.`,
    ];
    if (offer.rules) lines.push('', 'Rules of the group:', offer.rules, '', 'Joining signs your agreement to them.');
    lines.push('', 'Joining sends your display name and public keys to the group admin, who approves it in their app.');

    const notice = this.addNotice(lines.join('\n'), offer.groupId);
    this.updateOffer({ ...offer, noticeSeq: notice.seq });
  }

  private updateOffer(offer: Offer) {
    this.state.offers[offer.groupId] = offer;
    this.scheduleSave();
    this.listener.onOffer(offer);
  }

  private handleInvitation(invitation: GroupInvitation, verifiedSender?: string) {
    // Only Tyranny groups carry chat in the current apps, and their admin must sign
    if (invitation.groupType !== SUPPORTED_GROUP_TYPE || !verifiedSender) return;
    if (!invitation.members.some(({ publicKey }) => publicKey === this.me.blsPublicKey)) return;

    const existing = this.state.groups[invitation.groupId];
    if (existing && existing.adminSendingKey !== verifiedSender) return;

    const depth = TIER_DEPTHS[invitation.tier];
    if (depth === undefined) return;

    let isCommitmentConsistent: boolean | undefined;
    if (invitation.commitment) {
      // Leaves in the order of their members' compressed keys, as every peer sorts them before hashing
      const sorted = [...invitation.members].sort((a, b) => (a.publicKey < b.publicKey ? -1 : 1));
      const root = computeMerkleRoot(sorted.map(({ leafHash }) => fromHex(leafHash)), depth);
      const commitment = toHex(computeCommitment(root, invitation.epoch, fromHex(invitation.salt)));
      isCommitmentConsistent = commitment === invitation.commitment;
      // A roster that does not produce its own commitment is refused, as the apps refuse it
      if (!isCommitmentConsistent) return;
    }

    if (existing && BigInt(existing.epoch) > invitation.epoch) return;

    const group: Group = {
      id: invitation.groupId,
      name: invitation.name,
      groupSecret: invitation.groupSecret,
      members: invitation.members,
      memberProfiles: { ...existing?.memberProfiles, ...invitation.memberProfiles },
      epoch: invitation.epoch.toString(),
      salt: invitation.salt,
      commitment: invitation.commitment,
      tier: invitation.tier,
      adminPublicKey: invitation.adminPublicKey,
      adminSendingKey: verifiedSender,
      avatar: invitation.avatar ?? existing?.avatar,
      invitationMessage: normalizeRules(invitation.invitationMessage) ?? existing?.invitationMessage,
      joinedAt: existing?.joinedAt || Date.now(),
      isCommitmentConsistent,
      lastReadInboxSeq: existing?.lastReadInboxSeq || 0,
      lastReadOutboxSeq: existing?.lastReadOutboxSeq || 0,
      lastSeq: existing?.lastSeq,
    };
    this.updateGroup(group, !existing);

    const offer = this.state.offers[group.id];
    if (offer) {
      delete this.state.offers[group.id];
      this.listener.onOffer({ ...offer, status: 'declined' });
    }
    if (!existing) this.addNotice(`You joined “${group.name}”.`);

    const parked = this.state.parked[group.id];
    if (parked) {
      delete this.state.parked[group.id];
      parked.forEach(({ plaintext, verifiedSender: sender, eventTimeMs }) => {
        this.dispatch(new TextEncoder().encode(plaintext), sender, eventTimeMs);
      });
    }
  }

  private handleAnnouncement(announcement: MemberAnnouncement, verifiedSender?: string) {
    const group = this.state.groups[announcement.groupId];
    if (!group || !this.isAdmin(group, verifiedSender)) return;

    const { blsPublicKey, ...profile } = announcement.newMember;
    this.updateGroup({
      ...group,
      memberProfiles: { ...group.memberProfiles, [blsPublicKey]: profile },
      commitment: announcement.commitment ?? group.commitment,
      epoch: announcement.epoch !== undefined ? announcement.epoch.toString() : group.epoch,
    });
  }

  private handleName(change: GroupNameChange, verifiedSender?: string) {
    const group = this.state.groups[change.groupId];
    if (!group || !this.isAdmin(group, verifiedSender) || !change.name.trim()) return;
    this.updateGroup({ ...group, name: change.name });
  }

  private handleAvatar(change: GroupAvatarChange, verifiedSender?: string) {
    const group = this.state.groups[change.groupId];
    if (!group || !this.isAdmin(group, verifiedSender)) return;
    this.updateGroup({ ...group, avatar: change.avatar });
  }

  private handleReceipt(receipt: ChatReceipt, verifiedSender?: string) {
    const group = this.state.groups[receipt.groupId];
    const profile = group?.memberProfiles[receipt.senderBlsPublicKey];
    if (!group || !profile || profile.sendingPublicKey !== verifiedSender) return;

    // Read status is mutual, as in the Onym apps: with receipts off, others' reads are not shown either
    if (receipt.kind === 'read' && !this.sendsReadReceipts()) return;

    const ids = new Set(receipt.messageIds);
    let maxReadSeq = group.lastReadOutboxSeq;
    this.getMessages(group.id).forEach((message) => {
      if (!message.isOutgoing || !ids.has(message.logicalId)) return;
      if (receipt.kind === 'read') {
        maxReadSeq = Math.max(maxReadSeq, message.seq + getMessageSpan(message) - 1);
        if (message.status !== 'read') this.updateMessage({ ...message, status: 'read' });
      } else if (message.status === 'sent' || message.status === 'pending') {
        this.updateMessage({ ...message, status: 'delivered' });
      }
    });
    if (maxReadSeq > group.lastReadOutboxSeq) this.updateGroup({ ...group, lastReadOutboxSeq: maxReadSeq });
  }

  private handleChatMessage(
    message: ChatMessage, plaintext: Uint8Array, verifiedSender: string | undefined, eventTimeMs: number,
  ) {
    if (!verifiedSender) return;

    const group = this.state.groups[message.groupId];
    if (!group) {
      // Messages can arrive ahead of their group's invitation; they wait for it
      const parked = this.state.parked[message.groupId] || [];
      if (Object.values(this.state.parked).flat().length < PARKED_LIMIT) {
        this.state.parked[message.groupId] = [
          ...parked, { plaintext: new TextDecoder().decode(plaintext), verifiedSender, eventTimeMs },
        ];
        this.scheduleSave();
      }
      return;
    }

    // The envelope's signer must be the member the message claims to be from
    const profile = group.memberProfiles[message.senderBlsPublicKey];
    if (!profile || profile.sendingPublicKey !== verifiedSender) return;
    if (message.variantKind !== SUPPORTED_GROUP_TYPE) return;
    if (message.senderBlsPublicKey === this.me.blsPublicKey) return;
    if (this.findMessage(group.id, message.messageId)) return;
    if (this.state.cleared?.[group.id]?.includes(message.messageId)) return;

    this.insertMessage({
      logicalId: message.messageId,
      groupId: group.id,
      senderBls: message.senderBlsPublicKey,
      sentAtMs: message.sentAtMs || eventTimeMs,
      text: message.body,
      replyTo: message.replyToMessageId,
      isOutgoing: false,
      image: message.image,
      images: message.images,
      voice: message.voice,
      hasUnsupportedMedia: message.hasUnsupportedMedia,
    });

    void this.sendReceipt(group, message.senderBlsPublicKey, 'delivered', [message.messageId]);
  }

  private isAdmin(group: Group, verifiedSender?: string) {
    return Boolean(verifiedSender) && group.adminSendingKey === verifiedSender;
  }

  private async sendReceipt(group: Group, recipientBls: string, kind: ChatReceipt['kind'], messageIds: string[]) {
    const profile = group.memberProfiles[recipientBls];
    if (!profile || !messageIds.length) return;
    const payload = encodeReceipt({
      groupId: group.id, senderBlsPublicKey: this.me.blsPublicKey, kind, messageIds,
    });
    await this.sendToInbox(profile.inboxPublicKey, payload);
  }

  // One sealed copy per member, each to that member's own inbox
  private sendToMembers(group: Group, payload: Uint8Array) {
    const recipients = Object.entries(group.memberProfiles)
      .filter(([bls]) => bls !== this.me.blsPublicKey)
      .map(([, profile]) => profile.inboxPublicKey);
    return Promise.all(recipients.map((inbox) => this.sendToInbox(inbox, payload)));
  }

  private async sendToInbox(inboxPublicKey: string, payload: Uint8Array) {
    const recipient = fromHex(inboxPublicKey);
    const sealed = await sealEnvelope(payload, recipient, this.secrets.sendingSeed);
    const result = await this.pool.publish(buildInboxEvent(getInboxTag(recipient), sealed));
    return Object.values(result.outcomes).some(({ outcome }) => outcome === 'accepted');
  }

  private insertMessage(message: Omit<Message, 'seq'>) {
    const list = this.state.messages[message.groupId] || [];
    const group = this.state.groups[message.groupId];
    const last = list[list.length - 1];
    const lastSeq = Math.max(last ? last.seq + getMessageSpan(last) - 1 : 0, group?.lastSeq || 0);
    const inserted: Message = { ...message, seq: lastSeq + 1 };
    this.state.messages[message.groupId] = [...list, inserted];
    if (group) group.lastSeq = inserted.seq + getMessageSpan(inserted) - 1;
    this.scheduleSave();
    this.listener.onMessage(inserted, true);
    return inserted;
  }

  private updateMessage(message: Message) {
    const list = this.state.messages[message.groupId] || [];
    this.state.messages[message.groupId] = list.map((item) => (item.seq === message.seq ? message : item));
    this.scheduleSave();
    this.listener.onMessage(message, false);
  }

  private findMessage(groupId: string, logicalId: string) {
    return this.getMessages(groupId).find((message) => message.logicalId === logicalId);
  }

  private updateGroup(group: Group, isNew = false) {
    this.state.groups[group.id] = group;
    this.scheduleSave();
    this.listener.onGroup(group, isNew);
  }

  private rememberProcessed(eventId: string) {
    this.processed.add(eventId);
    this.state.processedEvents.push(eventId);
    if (this.state.processedEvents.length > PROCESSED_EVENTS_LIMIT) {
      const dropped = this.state.processedEvents.splice(0, this.state.processedEvents.length - PROCESSED_EVENTS_LIMIT);
      dropped.forEach((id) => this.processed.delete(id));
    }
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void writeSealed(STATE_ENTRY, this.state);
    }, SAVE_DELAY_MS);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    return writeSealed(STATE_ENTRY, this.state);
  }
}
