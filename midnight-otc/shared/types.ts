export type Side = "buy" | "sell";

export type AssetPair =
  | "BTC/USDC"
  | "ETH/USDC"
  | "DUST/USDC"
  | "BTC/ETH"
  | string;

export interface PlaintextOrder {
  price: number;
  amount: number;
  side: Side;
  assetPair: AssetPair;
  makerAllowlist?: string[];
  expiry: number;
  nonce: string;
}

export function isValidHex(value: string, expectedLen: number): boolean {
  return /^[0-9a-f]+$/i.test(value) && value.length === expectedLen;
}

export function assertHex(value: string, expectedLen: number, field: string): void {
  if (typeof value !== "string" || !isValidHex(value, expectedLen)) {
    throw new Error(`${field} must be a ${expectedLen}-char hex string`);
  }
}

export interface EncryptedOrder {
  commitment: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  assetPair: AssetPair;
  directionBit: 0 | 1;
  expiry: number;
  makerAddress: string;
  makerPublicKey: string;
  signature: string;
  encryptedAesKey: string;
}

export interface RelayerOrderEntry {
  id: string;
  commitment: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  assetPair: AssetPair;
  directionBit: 0 | 1;
  expiry: number;
  makerAddress: string;
  makerPublicKey: string;
  signature: string;
  creatorPeerId?: string;
  receivedAt: number;
  status: "open" | "matched" | "filled" | "cancelled" | "expired";
}

export interface MatchSignal {
  matchId: string;
  makerOrderId: string;
  takerOrderId: string;
  takerConnectionId?: string;
  takerPublicKey?: string;
  assetPair: AssetPair;
  timestamp: number;
}

export interface OnChainCommitment {
  maker: string;
  ciphertextHash: string;
  deadline: number;
  feeDeposit: bigint;
  tokenIn: string;
  tokenOut: string;
  escrowed: bigint;
  filled: boolean;
  cancelled: boolean;
}

export interface RevealPayload {
  commitment: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  takerAddress: string;
  takerCredentialProof: string;
}

export interface SettlementResult {
  success: boolean;
  txHash?: string;
  makerReceived?: bigint;
  takerReceived?: bigint;
  error?: string;
}

export type WsMessage =
  | { type: "order:new";          payload: RelayerOrderEntry }
  | { type: "order:cancelled";    payload: { id: string } }
  | { type: "order:filled";       payload: { id: string } }
  | { type: "match:signal";       payload: MatchSignal }
  | { type: "orderbook:snapshot"; payload: RelayerOrderEntry[] }
  | { type: "order:key:received"; payload: { orderId: string; encryptedAesKey: string } }
  | { type: "error";              payload: { code: string; message: string } };

const WS_MESSAGE_TYPES = [
  "order:new", "order:cancelled", "order:filled",
  "match:signal", "orderbook:snapshot", "order:key:received", "error",
] as const;

export function validateWsMessage(msg: unknown): WsMessage {
  if (typeof msg !== "object" || msg === null) {
    throw new Error("WsMessage must be a non-null object");
  }
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== "string") {
    throw new Error("WsMessage.type must be a string");
  }
  if (!(WS_MESSAGE_TYPES as readonly string[]).includes(m.type)) {
    throw new Error(`Unknown WsMessage type: "${m.type}"`);
  }
  if (m.payload === undefined || m.payload === null) {
    throw new Error("WsMessage must have a payload");
  }
  return msg as WsMessage;
}

export function isValidDirectionBit(v: unknown): v is 0 | 1 {
  return v === 0 || v === 1;
}

export function isValidCredentialProof(proof: string): boolean {
  return proof === "verified" || proof.startsWith("vc:");
}

export function validateOrderPayload(
  order: Partial<Omit<EncryptedOrder, "encryptedAesKey">>
): void {
  if (!order.commitment) throw new Error("Missing commitment");
  if (!order.ciphertext) throw new Error("Missing ciphertext");
  if (!order.iv) throw new Error("Missing IV");
  if (!order.authTag) throw new Error("Missing authTag");
  if (!order.salt) throw new Error("Missing salt");
  if (!order.signature) throw new Error("Missing signature");

  assertHex(order.commitment, 64, "commitment");
  assertHex(order.ciphertext, order.ciphertext.length, "ciphertext");
  assertHex(order.iv, 24, "iv");
  assertHex(order.authTag, 32, "authTag");
  assertHex(order.salt, 64, "salt");
  assertHex(order.signature, order.signature.length, "signature");

  if (!order.assetPair) throw new Error("Missing assetPair");
  if (!isValidDirectionBit(order.directionBit)) {
    throw new Error("directionBit must be 0 or 1");
  }
  if (!order.expiry || order.expiry < Math.floor(Date.now() / 1000)) {
    throw new Error("Order expired or missing expiry");
  }
  if (!order.makerAddress) throw new Error("Missing makerAddress");
  if (!order.makerPublicKey) throw new Error("Missing makerPublicKey");
}
