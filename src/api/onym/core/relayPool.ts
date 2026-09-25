import { sha256 } from '@noble/hashes/sha2.js';

import type { NostrEvent } from './nostr';

import { toHex, utf8 } from './bytes';
import { buildInboxFilters, openInboxEvent } from './nostr';

// One WebSocket per selected relay, every subscription replayed on each of them (UI-Message-Nostr.md §3, §8)
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 120_000;
const PUBLISH_TIMEOUT_MS = 8000;
const MAX_FRAME_LENGTH = 1_048_576;
const SEEN_EVENTS_LIMIT = 20_000;

export type RelayOutcome = 'accepted' | 'rejected' | 'unreachable' | 'unknown';

export type PublishResult = {
  eventId: string;
  outcomes: Record<string, { outcome: RelayOutcome; reason?: string }>;
};

export type Inbound = {
  inbox: string;
  event: NostrEvent;
  payload: Uint8Array;
  relay: string;
};

type Subscription = {
  key: string;
  inbox: string;
  generation: number;
  onEvent: (inbound: Inbound) => void;
  onCaughtUp?: (relay: string) => void;
};

type PendingPublish = {
  resolve: (outcome: { outcome: RelayOutcome; reason?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RelayState = {
  url: string;
  socket?: WebSocket;
  isOpen: boolean;
  retryMs: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  subIdsByKey: Map<string, string>;
  keysBySubId: Map<string, string>;
  pending: Map<string, PendingPublish>;
};

export type RelayStatusListener = (connectedCount: number, totalCount: number) => void;

export class RelayPool {
  private relays = new Map<string, RelayState>();

  private subscriptions = new Map<string, Subscription>();

  private seenEvents = new Set<string>();

  private generation = 0;

  private isWanted = false;

  constructor(private onStatus?: RelayStatusListener) {}

  setRelays(urls: string[]) {
    const wanted = new Set(urls);
    this.relays.forEach((relay, url) => {
      if (!wanted.has(url)) {
        this.closeRelay(relay);
        this.relays.delete(url);
      }
    });
    wanted.forEach((url) => {
      if (this.relays.has(url)) return;
      const relay: RelayState = {
        url,
        isOpen: false,
        retryMs: RECONNECT_MIN_MS,
        subIdsByKey: new Map(),
        keysBySubId: new Map(),
        pending: new Map(),
      };
      this.relays.set(url, relay);
      if (this.isWanted) this.connect(relay);
    });
    this.reportStatus();
  }

  getRelayUrls() {
    return [...this.relays.keys()];
  }

  connectAll() {
    this.isWanted = true;
    this.relays.forEach((relay) => this.connect(relay));
  }

  // Explicit disconnect is sticky: delayed reconnect work checks `isWanted` (§8.8)
  disconnectAll() {
    this.isWanted = false;
    this.relays.forEach((relay) => this.closeRelay(relay));
    this.reportStatus();
  }

  subscribe(key: string, inbox: string, onEvent: Subscription['onEvent'], onCaughtUp?: Subscription['onCaughtUp']) {
    const subscription: Subscription = {
      key, inbox, generation: ++this.generation, onEvent, onCaughtUp,
    };
    this.unsubscribe(key);
    this.subscriptions.set(key, subscription);
    this.relays.forEach((relay) => {
      if (relay.isOpen) this.sendReq(relay, subscription);
    });
  }

  unsubscribe(key: string) {
    if (!this.subscriptions.delete(key)) return;
    this.relays.forEach((relay) => {
      const subId = relay.subIdsByKey.get(key);
      if (!subId) return;
      relay.subIdsByKey.delete(key);
      relay.keysBySubId.delete(subId);
      if (relay.isOpen) relay.socket!.send(JSON.stringify(['CLOSE', subId]));
    });
  }

  // Resolves with one outcome per relay; silence is `unknown`, never `accepted` (§10)
  async publish(event: NostrEvent): Promise<PublishResult> {
    const entries = await Promise.all([...this.relays.values()].map(async (relay) => {
      if (!relay.isOpen) return [relay.url, { outcome: 'unreachable' as RelayOutcome }] as const;

      const outcome = await new Promise<{ outcome: RelayOutcome; reason?: string }>((resolve) => {
        const timer = setTimeout(() => {
          relay.pending.delete(event.id);
          resolve({ outcome: 'unknown' });
        }, PUBLISH_TIMEOUT_MS);
        relay.pending.set(event.id, { resolve, timer });
        try {
          relay.socket!.send(JSON.stringify(['EVENT', event]));
        } catch {
          clearTimeout(timer);
          relay.pending.delete(event.id);
          resolve({ outcome: 'unreachable' });
        }
      });
      return [relay.url, outcome] as const;
    }));

    return { eventId: event.id, outcomes: Object.fromEntries(entries) };
  }

  private connect(relay: RelayState) {
    if (relay.socket || !this.isWanted) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(relay.url);
    } catch {
      this.scheduleReconnect(relay);
      return;
    }
    relay.socket = socket;

    socket.onopen = () => {
      if (relay.socket !== socket) return;
      relay.isOpen = true;
      relay.retryMs = RECONNECT_MIN_MS;
      relay.subIdsByKey.clear();
      relay.keysBySubId.clear();
      this.subscriptions.forEach((subscription) => this.sendReq(relay, subscription));
      this.reportStatus();
    };

    socket.onmessage = ({ data }) => {
      if (relay.socket !== socket || typeof data !== 'string' || data.length > MAX_FRAME_LENGTH) return;
      this.handleFrame(relay, data);
    };

    socket.onclose = () => {
      if (relay.socket !== socket) return;
      this.dropSocket(relay);
      this.scheduleReconnect(relay);
    };

    socket.onerror = () => {
      // `onclose` follows and owns the reconnect
    };
  }

  private handleFrame(relay: RelayState, data: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') return;

    switch (frame[0]) {
      case 'EVENT': {
        const key = typeof frame[1] === 'string' ? relay.keysBySubId.get(frame[1]) : undefined;
        const subscription = key !== undefined ? this.subscriptions.get(key) : undefined;
        if (!subscription) return;

        const opened = openInboxEvent(frame[2], subscription.inbox);
        if (!opened || this.seenEvents.has(opened.event.id)) return;
        this.rememberEvent(opened.event.id);

        subscription.onEvent({ inbox: subscription.inbox, ...opened, relay: relay.url });
        break;
      }
      case 'EOSE': {
        const key = typeof frame[1] === 'string' ? relay.keysBySubId.get(frame[1]) : undefined;
        const subscription = key !== undefined ? this.subscriptions.get(key) : undefined;
        subscription?.onCaughtUp?.(relay.url);
        break;
      }
      case 'OK': {
        const [, eventId, isAccepted, reason] = frame;
        const pending = typeof eventId === 'string' ? relay.pending.get(eventId) : undefined;
        if (!pending) return;
        clearTimeout(pending.timer);
        relay.pending.delete(eventId);
        pending.resolve({
          outcome: isAccepted === true ? 'accepted' : 'rejected',
          reason: typeof reason === 'string' ? reason.slice(0, 256) : undefined,
        });
        break;
      }
      case 'CLOSED': {
        const key = typeof frame[1] === 'string' ? relay.keysBySubId.get(frame[1]) : undefined;
        if (key === undefined) return;
        relay.keysBySubId.delete(frame[1]);
        relay.subIdsByKey.delete(key);
        break;
      }
      default:
        // `NOTICE` and `AUTH` are diagnostics here: this client does not hold relay-scoped seat keys yet
        break;
    }
  }

  private sendReq(relay: RelayState, subscription: Subscription) {
    // Subscription ids carry no raw address and are unique per generation (§7.2)
    const subId = `onym-${toHex(sha256(utf8(subscription.key))).slice(0, 16)}-${subscription.generation}`;
    const previous = relay.subIdsByKey.get(subscription.key);
    if (previous) relay.keysBySubId.delete(previous);
    relay.subIdsByKey.set(subscription.key, subId);
    relay.keysBySubId.set(subId, subscription.key);

    relay.socket!.send(JSON.stringify(['REQ', subId, ...buildInboxFilters(subscription.inbox)]));
  }

  private rememberEvent(id: string) {
    this.seenEvents.add(id);
    if (this.seenEvents.size > SEEN_EVENTS_LIMIT) {
      const oldest = this.seenEvents.values().next().value!;
      this.seenEvents.delete(oldest);
    }
  }

  private scheduleReconnect(relay: RelayState) {
    if (!this.isWanted || relay.retryTimer || !this.relays.has(relay.url)) return;
    const delay = relay.retryMs * (0.5 + Math.random() / 2);
    relay.retryMs = Math.min(relay.retryMs * 2, RECONNECT_MAX_MS);
    relay.retryTimer = setTimeout(() => {
      relay.retryTimer = undefined;
      this.connect(relay);
    }, delay);
  }

  private closeRelay(relay: RelayState) {
    if (relay.retryTimer) {
      clearTimeout(relay.retryTimer);
      relay.retryTimer = undefined;
    }
    const { socket } = relay;
    this.dropSocket(relay);
    socket?.close();
  }

  private dropSocket(relay: RelayState) {
    relay.socket = undefined;
    relay.isOpen = false;
    relay.subIdsByKey.clear();
    relay.keysBySubId.clear();
    relay.pending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ outcome: 'unknown' });
    });
    relay.pending.clear();
    this.reportStatus();
  }

  private reportStatus() {
    const connected = [...this.relays.values()].filter((relay) => relay.isOpen).length;
    this.onStatus?.(connected, this.relays.size);
  }
}
