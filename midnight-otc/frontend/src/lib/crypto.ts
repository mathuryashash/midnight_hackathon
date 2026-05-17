import type { PlaintextOrder, EncryptedOrder } from "../../../shared/types";

export interface ECDHKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyHex: string;
}

export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );

  const exported = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyHex = bufToHex(new Uint8Array(exported));

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyHex,
  };
}

export async function importPeerPublicKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBuf(hexKey);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

/**
 * Derive a shared AES-256-GCM key from our private key + peer's public key.
 * Uses HKDF-SHA256 with domain separation (info) and a random salt
 * to prevent key reuse across sessions/orders.
 */
export async function deriveSharedKey(
  ourPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  salt?: BufferSource
): Promise<CryptoKey> {
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    ourPrivateKey,
    256
  );

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt ?? new Uint8Array(32),
      info: new TextEncoder().encode("midnight-otc-v1::aes-key"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface EncryptResult {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  commitment: string;
  aesKey: CryptoKey;
}

export async function encryptOrder(order: PlaintextOrder): Promise<EncryptResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(32));

  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  const plaintext = new TextEncoder().encode(JSON.stringify(order));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    plaintext
  );

  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertextBytes = encryptedBytes.slice(0, -16);
  const authTagBytes = encryptedBytes.slice(-16);

  const ciphertextHex = bufToHex(ciphertextBytes);
  const ivHex = bufToHex(iv);
  const authTagHex = bufToHex(authTagBytes);
  const saltHex = bufToHex(salt);

  const commitInput = buildCommitmentInput(ciphertextHex, ivHex, authTagHex, saltHex);
  const commitHash = await crypto.subtle.digest("SHA-256", commitInput);
  const commitment = bufToHex(new Uint8Array(commitHash));

  return {
    ciphertext: ciphertextHex,
    iv: ivHex,
    authTag: authTagHex,
    salt: saltHex,
    commitment,
    aesKey,
  };
}

export async function decryptOrder(
  ciphertextHex: string,
  ivHex: string,
  authTagHex: string,
  aesKeyHex: string
): Promise<PlaintextOrder> {
  const keyBytes = hexToBuf(aesKeyHex);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const ciphertextBytes = hexToBuf(ciphertextHex);
  const authTagBytes = hexToBuf(authTagHex);
  const combined = new Uint8Array(ciphertextBytes.byteLength + 16);
  combined.set(new Uint8Array(ciphertextBytes), 0);
  combined.set(new Uint8Array(authTagBytes), ciphertextBytes.byteLength);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBuf(ivHex), tagLength: 128 },
    aesKey,
    combined
  );

  return JSON.parse(new TextDecoder().decode(decrypted)) as PlaintextOrder;
}

/**
 * Encrypt the maker's AES key to the taker's ECDH public key.
 * Accepts the raw CryptoKey (never exported to JS heap by caller).
 * Uses HKDF-derived shared key with a fresh random salt.
 */
export async function encryptKeyForTaker(
  aesKey: CryptoKey,
  makerPrivateKey: CryptoKey,
  takerPublicKey: CryptoKey
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const sharedKey = await deriveSharedKey(makerPrivateKey, takerPublicKey, salt);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const exportedKey = await crypto.subtle.exportKey("raw", aesKey);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    sharedKey,
    exportedKey
  );

  // Return salt ++ iv ++ encrypted as hex
  const result = new Uint8Array(32 + 12 + encrypted.byteLength);
  result.set(salt, 0);
  result.set(iv, 32);
  result.set(new Uint8Array(encrypted), 44);
  return bufToHex(result);
}

/**
 * Decrypt the AES key that the maker encrypted to our ECDH public key.
 */
export async function decryptKeyFromMaker(
  encryptedKeyHex: string,
  takerPrivateKey: CryptoKey,
  makerPublicKey: CryptoKey
): Promise<string> {
  const raw = hexToBuf(encryptedKeyHex);
  const salt = raw.slice(0, 32);
  const iv = raw.slice(32, 44);
  const encrypted = raw.slice(44);

  const sharedKey = await deriveSharedKey(takerPrivateKey, makerPublicKey, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    sharedKey,
    encrypted
  );

  return bufToHex(new Uint8Array(decrypted));
}

export async function verifyCommitment(
  ciphertextHex: string,
  ivHex: string,
  authTagHex: string,
  saltHex: string,
  expectedCommitment: string
): Promise<boolean> {
  const commitInput = buildCommitmentInput(ciphertextHex, ivHex, authTagHex, saltHex);
  const hash = await crypto.subtle.digest("SHA-256", commitInput);
  const computed = bufToHex(new Uint8Array(hash));
  return computed === expectedCommitment;
}

export function buildEncryptedOrder(
  result: EncryptResult,
  order: PlaintextOrder,
  makerAddress: string,
  makerPublicKey: string,
  signature = ""
): Omit<EncryptedOrder, "encryptedAesKey"> {
  if (order.side !== "buy" && order.side !== "sell") {
    throw new Error(`buildEncryptedOrder: invalid side "${order.side}"`);
  }

  return {
    commitment: result.commitment,
    ciphertext: result.ciphertext,
    iv: result.iv,
    authTag: result.authTag,
    salt: result.salt,
    assetPair: order.assetPair,
    directionBit: order.side === "buy" ? 0 : 1,
    expiry: order.expiry,
    makerAddress,
    makerPublicKey,
    signature,
  };
}

/**
 * Build commitment hash input with 4-byte big-endian length prefixes.
 * Prevents ambiguity from variable-length fields.
 */
export function buildCommitmentInput(...parts: string[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    const content = encoder.encode(part);
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, content.byteLength, false);
    chunks.push(lenBuf, content);
  }

  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBuf(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0) throw new Error(`hexToBuf: odd-length hex string (${hex.length} chars)`);
  if (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex)) throw new Error("hexToBuf: non-hex characters in input");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes.buffer;
}

export function generateNonce(): string {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));
}
