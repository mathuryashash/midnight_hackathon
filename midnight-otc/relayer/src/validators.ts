import { z } from "zod";
import type { WsMessage, RelayerOrderEntry } from "../../shared/types";
import type { ClientMessage } from "./types";
import {
  validateWsMessage as sharedValidateWsMessage,
  validateOrderPayload as sharedValidateOrderPayload,
} from "../../shared/types";

const hexString = (length: number) =>
  z.string().regex(/^[0-9a-f]+$/i).length(length);

export const encryptedOrderSchema = z.object({
  commitment: hexString(64),
  ciphertext: z.string().regex(/^[0-9a-f]+$/i).min(1),
  iv: hexString(24),
  authTag: hexString(32),
  salt: hexString(64),
  assetPair: z.string().min(1),
  directionBit: z.union([z.literal(0), z.literal(1)]),
  expiry: z.number().int().positive(),
  makerAddress: z.string().min(1),
  makerPublicKey: z.string().min(1),
  signature: z.string().regex(/^[0-9a-f]+$/i).min(1),
});

export const wsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("order:new"), payload: z.any() }),
  z.object({ type: z.literal("order:cancelled"), payload: z.object({ id: z.string() }) }),
  z.object({ type: z.literal("order:filled"), payload: z.object({ id: z.string() }) }),
  z.object({ type: z.literal("match:signal"), payload: z.any() }),
  z.object({ type: z.literal("orderbook:snapshot"), payload: z.array(z.any()) }),
  z.object({ type: z.literal("order:key:received"), payload: z.object({ orderId: z.string(), encryptedAesKey: z.string() }) }),
  z.object({ type: z.literal("error"), payload: z.object({ code: z.string(), message: z.string() }) }),
]);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("order:submit"), payload: z.unknown().optional() }),
  z.object({ type: z.literal("order:key"), payload: z.unknown().optional() }),
  z.object({ type: z.literal("match:interest"), payload: z.unknown().optional() }),
  z.object({ type: z.literal("ping"), payload: z.unknown().optional() }),
]);

export const matchInterestSchema = z.object({
  orderId: z.string(),
  takerPublicKey: z.string(),
});

export function validateWsMessage(msg: unknown): WsMessage {
  return sharedValidateWsMessage(msg);
}

export function validateOrderPayload(order: unknown): void {
  sharedValidateOrderPayload(order as Parameters<typeof sharedValidateOrderPayload>[0]);
}

export function validateClientMessage(msg: unknown): ClientMessage {
  return clientMessageSchema.parse(msg) as ClientMessage;
}
