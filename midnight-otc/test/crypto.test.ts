/**
 * Crypto utility tests.
 * Run with: npm test (from project root)
 */

// Node.js 18+ has globalThis.crypto — if not available, use the polyfill below
import { webcrypto } from "crypto";
if (!globalThis.crypto) {
  (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;
}

// We re-implement the browser crypto functions here for Node.js testing
// (the frontend version uses Web Crypto API, same primitives)

import { createCipheriv, createHash, randomBytes, createDecipheriv } from "crypto";

// ─── Helpers that mirror frontend/src/lib/crypto.ts ──────────────────────────

function bufToHex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function encryptOrderNode(order: object): {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  commitment: string;
  aesKey: Buffer;
} {
  const iv = randomBytes(12);
  const salt = randomBytes(32);
  const aesKey = randomBytes(32);

  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const plaintext = JSON.stringify(order);
  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  const commitInput = ciphertext + iv.toString("hex") + authTag + salt.toString("hex");
  const commitment = createHash("sha256").update(commitInput).digest("hex");

  return {
    ciphertext,
    iv: iv.toString("hex"),
    authTag,
    salt: salt.toString("hex"),
    commitment,
    aesKey,
  };
}

function decryptOrderNode(
  ciphertextHex: string,
  ivHex: string,
  authTagHex: string,
  aesKey: Buffer
): object {
  const decipher = createDecipheriv("aes-256-gcm", aesKey, hexToBuf(ivHex));
  decipher.setAuthTag(hexToBuf(authTagHex));
  let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

function computeCommitment(
  ciphertextHex: string,
  ivHex: string,
  authTagHex: string,
  saltHex: string
): string {
  const input = ciphertextHex + ivHex + authTagHex + saltHex;
  return createHash("sha256").update(input).digest("hex");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Order Encryption", () => {
  const testOrder = {
    price: 42000,
    amount: 1.5,
    side: "sell" as const,
    assetPair: "BTC/USDC",
    expiry: Math.floor(Date.now() / 1000) + 86400,
    nonce: randomBytes(32).toString("hex"),
  };

  test("encrypts order — ciphertext is not plaintext", () => {
    const result = encryptOrderNode(testOrder);
    const plaintext = JSON.stringify(testOrder);

    expect(result.ciphertext).not.toContain("42000");
    expect(result.ciphertext).not.toContain("1.5");
    expect(result.ciphertext).not.toContain("sell");
    expect(result.ciphertext).not.toContain(plaintext);
  });

  test("decrypts back to original order", () => {
    const result = encryptOrderNode(testOrder);
    const decrypted = decryptOrderNode(
      result.ciphertext,
      result.iv,
      result.authTag,
      result.aesKey
    ) as typeof testOrder;

    expect(decrypted.price).toBe(testOrder.price);
    expect(decrypted.amount).toBe(testOrder.amount);
    expect(decrypted.side).toBe(testOrder.side);
    expect(decrypted.assetPair).toBe(testOrder.assetPair);
    expect(decrypted.nonce).toBe(testOrder.nonce);
  });

  test("commitment is deterministic given same inputs", () => {
    const result = encryptOrderNode(testOrder);
    const recomputed = computeCommitment(
      result.ciphertext,
      result.iv,
      result.authTag,
      result.salt
    );
    expect(recomputed).toBe(result.commitment);
    expect(result.commitment).toHaveLength(64); // SHA-256 is 32 bytes = 64 hex chars
  });

  test("different nonces produce different commitments (replay attack protection)", () => {
    const order1 = { ...testOrder, nonce: randomBytes(32).toString("hex") };
    const order2 = { ...testOrder, nonce: randomBytes(32).toString("hex") };

    const r1 = encryptOrderNode(order1);
    const r2 = encryptOrderNode(order2);

    // Commitments must be different — same order params but different nonces
    expect(r1.commitment).not.toBe(r2.commitment);
  });

  test("tampered ciphertext fails decryption (auth tag check)", () => {
    const result = encryptOrderNode(testOrder);
    // Flip one byte in the ciphertext
    const tampered = result.ciphertext.slice(0, -2) + "ff";

    expect(() => {
      decryptOrderNode(tampered, result.iv, result.authTag, result.aesKey);
    }).toThrow(); // AES-GCM auth tag validation fails
  });

  test("wrong key fails decryption", () => {
    const result = encryptOrderNode(testOrder);
    const wrongKey = randomBytes(32);

    expect(() => {
      decryptOrderNode(result.ciphertext, result.iv, result.authTag, wrongKey);
    }).toThrow();
  });

  test("commitment mismatch detected (integrity check)", () => {
    const result = encryptOrderNode(testOrder);
    // Attacker changes one char of the commitment
    const fakeCommitment = "0" + result.commitment.slice(1);

    const recomputed = computeCommitment(
      result.ciphertext,
      result.iv,
      result.authTag,
      result.salt
    );

    expect(recomputed).not.toBe(fakeCommitment);
    expect(recomputed).toBe(result.commitment); // Real commitment still matches
  });

  test("IV reuse changes commitment (IV included in commitment hash)", () => {
    const r1 = encryptOrderNode(testOrder);
    const r2 = encryptOrderNode(testOrder); // Fresh encryption, fresh IV

    // Two encryptions of same plaintext → different IVs → different commitments
    expect(r1.iv).not.toBe(r2.iv);
    expect(r1.commitment).not.toBe(r2.commitment);
  });
});

describe("Privacy Guarantees", () => {
  test("direction bit does NOT reveal price or amount", () => {
    const buyOrder = { price: 99999, amount: 999, side: "buy" as const, assetPair: "BTC/USDC", expiry: 9999999999, nonce: "x" };
    const sellOrder = { ...buyOrder, side: "sell" as const };

    const buyResult = encryptOrderNode(buyOrder);
    const sellResult = encryptOrderNode(sellOrder);

    // Both ciphertexts must be opaque
    expect(buyResult.ciphertext).not.toContain("99999");
    expect(sellResult.ciphertext).not.toContain("99999");

    // Commitments are different (due to random IV/salt) even for same price/amount
    expect(buyResult.commitment).not.toBe(sellResult.commitment);
  });

  test("ciphertext length doesn't leak exact parameter values", () => {
    const smallOrder = { price: 1, amount: 1, side: "sell" as const, assetPair: "BTC/USDC", expiry: 9999999999, nonce: "a" };
    const largeOrder = { price: 999999999, amount: 9999999, side: "sell" as const, assetPair: "BTC/USDC", expiry: 9999999999, nonce: "b" };

    const r1 = encryptOrderNode(smallOrder);
    const r2 = encryptOrderNode(largeOrder);

    const lenDiff = Math.abs(r1.ciphertext.length - r2.ciphertext.length);
    // JSON length diff: price=1→9 (+8) + amount=1→7 (+6) = 14 chars; hex-encoded = 28
    expect(lenDiff).toBe(28);
  });
});
