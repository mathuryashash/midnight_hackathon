import type { RelayerOrderEntry, MatchSignal } from "../../shared/types";

export enum ErrorCode {
  PARSE_ERROR = "PARSE_ERROR",
  INVALID_ORDER = "INVALID_ORDER",
  BOOK_FULL = "BOOK_FULL",
  DUPLICATE = "DUPLICATE",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  AUTH_REQUIRED = "AUTH_REQUIRED",
  UNKNOWN_MSG = "UNKNOWN_MSG",
  RATE_LIMITED = "RATE_LIMITED",
  ORDER_NOT_FOUND = "ORDER_NOT_FOUND",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  PONG = "PONG",
}

export interface RelayerConfig {
  port: number;
  host: string;
  maxOrders: number;
  matchIntervalMs: number;
  maxSignalsPerScan: number;
  maxOrdersPerScan: number;
  rateLimitCapacity: number;
  rateLimitRefill: number;
  rateLimitRefillIntervalMs: number;
  peerOrderLimit: number;
  tlsEnabled: boolean;
  authEnabled: boolean;
  logLevel: string;
}

export interface ClientMessage {
  type:
    | "order:submit"
    | "order:key"
    | "match:interest"
    | "ping";
  payload?: unknown;
}

export interface PeerConnection {
  id: string;
  ws: import("ws").WebSocket;
  address?: string;
  publicKey?: string;
  connectedAt: number;
  orderCount: number;
}

export { RelayerOrderEntry, MatchSignal };
