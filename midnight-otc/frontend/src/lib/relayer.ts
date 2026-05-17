/**
 * Relayer WebSocket client.
 * Manages the connection to the off-chain order book aggregator.
 */

import type {
  RelayerOrderEntry,
  MatchSignal,
  EncryptedOrder,
} from "../../shared/types";
import { validateWsMessage, type WsMessage } from "../../shared/types";

export type RelayerEvent =
  | { event: "connected" }
  | { event: "disconnected" }
  | { event: "snapshot"; orders: RelayerOrderEntry[] }
  | { event: "order:new"; order: RelayerOrderEntry }
  | { event: "order:filled"; id: string }
  | { event: "order:cancelled"; id: string }
  | { event: "match:signal"; signal: MatchSignal }
  | { event: "key:received"; orderId: string; encryptedAesKey: string }
  | { event: "error"; code: string; message: string };

type Listener = (event: RelayerEvent) => void;

const RELAYER_URL =
  process.env.NEXT_PUBLIC_RELAYER_URL ?? "ws://localhost:3001";

class RelayerClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private connected = false;

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(RELAYER_URL);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        this.emit({ event: "connected" });
      };

      this.ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data as string);
          const msg = validateWsMessage(parsed);
          this.handleMessage(msg);
        } catch {
          console.error("[Relayer] Bad message:", evt.data);
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit({ event: "disconnected" });
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error("[Relayer] WebSocket error:", err);
      };
    } catch (err) {
      console.error("[Relayer] Connection failed:", err);
      this.scheduleReconnect();
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Submit an encrypted order to the relayer.
   * The relayer sees: assetPair, directionBit, ciphertext, commitment.
   * It NEVER sees price, amount, or maker identity beyond the address.
   */
  submitOrder(order: Omit<EncryptedOrder, "encryptedAesKey">): void {
    this.send({ type: "order:submit", payload: order });
  }

  /**
   * After a match is negotiated off-chain, update the order with the
   * encrypted AES key so the taker can retrieve and decrypt the order details.
   */
  updateOrderWithKey(orderId: string, encryptedAesKey: string): void {
    this.send({ type: "order:key", payload: { orderId, encryptedAesKey } });
  }

  /**
   * Signal intent to fill an order — taker announces interest.
   * The relayer connects maker and taker for off-chain key negotiation.
   */
  expressInterest(orderId: string, takerPublicKey: string): void {
    this.send({
      type: "match:interest",
      payload: { orderId, takerPublicKey },
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private handleMessage(msg: WsMessage) {
    switch (msg.type) {
      case "orderbook:snapshot":
        this.emit({ event: "snapshot", orders: msg.payload });
        break;
      case "order:new":
        this.emit({ event: "order:new", order: msg.payload });
        break;
      case "order:filled":
        this.emit({ event: "order:filled", id: msg.payload.id });
        break;
      case "order:cancelled":
        this.emit({ event: "order:cancelled", id: msg.payload.id });
        break;
      case "match:signal":
        this.emit({ event: "match:signal", signal: msg.payload });
        break;
      case "order:key:received":
        this.emit({
          event: "key:received",
          orderId: msg.payload.orderId,
          encryptedAesKey: msg.payload.encryptedAesKey,
        });
        break;
      case "error":
        this.emit({ event: "error", code: msg.payload.code, message: msg.payload.message });
        break;
    }
  }

  private send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("[Relayer] Cannot send — not connected");
    }
  }

  private emit(event: RelayerEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[Relayer] Listener error:", err);
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }
}

// Singleton client
export const relayerClient = new RelayerClient();

// ─── React hook ───────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";

export function useRelayer() {
  const [connected, setConnected] = useState(false);
  const [orders, setOrders] = useState<RelayerOrderEntry[]>([]);
  const [matchSignals, setMatchSignals] = useState<MatchSignal[]>([]);

  useEffect(() => {
    relayerClient.connect();

    const unsub = relayerClient.subscribe((event) => {
      switch (event.event) {
        case "connected":
          setConnected(true);
          break;
        case "disconnected":
          setConnected(false);
          break;
        case "snapshot":
          setOrders(event.orders);
          break;
        case "order:new":
          setOrders((prev) => [event.order, ...prev]);
          break;
        case "order:filled":
          setOrders((prev) =>
            prev.map((o) => (o.id === event.id ? { ...o, status: "filled" } : o))
          );
          break;
        case "order:cancelled":
          setOrders((prev) =>
            prev.map((o) => (o.id === event.id ? { ...o, status: "cancelled" } : o))
          );
          break;
        case "match:signal":
          setMatchSignals((prev) => [event.signal, ...prev.slice(0, 19)]);
          break;
      }
    });

    return () => {
      unsub();
    };
  }, []);

  const submitOrder = useCallback(
    (order: Omit<EncryptedOrder, "encryptedAesKey">) => {
      relayerClient.submitOrder(order);
    },
    []
  );

  const expressInterest = useCallback(
    (orderId: string, takerPublicKey: string) => {
      relayerClient.expressInterest(orderId, takerPublicKey);
    },
    []
  );

  return { connected, orders, matchSignals, submitOrder, expressInterest };
}
