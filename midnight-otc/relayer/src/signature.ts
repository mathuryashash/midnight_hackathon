/**
 * Signature verification for OTC orders.
 *
 * Uses ECDSA on the P-256 curve (prime256v1) with SHA-256 hashing,
 * matching the ECDH key exchange curve used elsewhere in the project.
 *
 * Public keys are 65-byte uncompressed points (0x04 || x || y).
 * Private keys are 32-byte scalar values.
 * Signatures are DER-encoded ECDSA (r, s).
 */

import { createVerify, createSign } from "crypto";

// ─── ASN.1 / DER building blocks ────────────────────────────────────────

/** OID for the P-256 / prime256v1 curve: 1.2.840.10045.3.1.7 */
const P256_OID = Buffer.from([
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
]);

/** OID for the EC public key algorithm: 1.2.840.10045.2.1 */
const EC_PUBLIC_KEY_OID = Buffer.from([
  0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
]);

/**
 * Build a DER-encoded SubjectPublicKeyInfo (SPKI) for a P-256
 * uncompressed public key point.
 */
function buildSpkiDer(rawPoint: Buffer): Buffer {
  // AlgorithmIdentifier SEQUENCE { ecPublicKey, P-256 }
  const algId = Buffer.concat([
    Buffer.from([0x30, 0x13]),
    EC_PUBLIC_KEY_OID,
    P256_OID,
  ]);

  // BIT STRING wrapping the 65-byte uncompressed point
  const bitStringPayload = Buffer.concat([Buffer.from([0x00]), rawPoint]);
  const bitString = Buffer.concat([
    Buffer.from([0x03, bitStringPayload.length]),
    bitStringPayload,
  ]);

  // Outer SEQUENCE { AlgorithmIdentifier, BIT STRING }
  const outer = Buffer.concat([algId, bitString]);
  return Buffer.concat([Buffer.from([0x30, outer.length]), outer]);
}

/**
 * Build a DER-encoded PKCS#8 PrivateKeyInfo for a P-256 private key.
 * The public key point in the [1] EXPLICIT is omitted — it is optional
 * and not needed for signing.
 */
function buildPkcs8Der(privateKey: Buffer): Buffer {
  // ECPrivateKey SEQUENCE { version(1), privateKey, parameters([0] P-256) }
  const ecPrivateKey = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]), // INTEGER 1
    Buffer.concat([Buffer.from([0x04, 0x20]), privateKey]), // OCTET STRING (32B)
    Buffer.from([0xa0, 0x0a]), // [0] EXPLICIT (parameters)
    P256_OID,
  ]);
  const ecPrivateKeySeq = Buffer.concat([
    Buffer.from([0x30, ecPrivateKey.length]),
    ecPrivateKey,
  ]);

  // AlgorithmIdentifier { ecPublicKey, P-256 }
  const algId = Buffer.concat([
    Buffer.from([0x30, 0x13]),
    EC_PUBLIC_KEY_OID,
    P256_OID,
  ]);

  // OCTET STRING wrapping the ECPrivateKey SEQUENCE
  const wrappedKey = Buffer.concat([
    Buffer.from([0x04, ecPrivateKeySeq.length]),
    ecPrivateKeySeq,
  ]);

  // PKCS#8 outer { version(1), AlgorithmIdentifier, privateKey }
  const pkcs8 = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]),
    algId,
    wrappedKey,
  ]);
  return Buffer.concat([Buffer.from([0x30, pkcs8.length]), pkcs8]);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Verify an ECDSA/P-256 signature over a payload string.
 *
 * @param payload      The plaintext that was signed (utf-8 string).
 * @param signature    DER-encoded ECDSA signature (hex).
 * @param publicKeyHex Uncompressed P-256 public key, 130 hex chars (04 || x || y).
 * @returns `true` if the signature is valid, `false` on any error.
 */
export function verifySignature(
  payload: string,
  signature: string,
  publicKeyHex: string,
): boolean {
  try {
    const rawPoint = Buffer.from(publicKeyHex, "hex");
    if (rawPoint.length !== 65 || rawPoint[0] !== 0x04) return false;

    const sigBuf = Buffer.from(signature, "hex");
    const payloadBuf = Buffer.from(payload, "utf-8");
    const spkiDer = buildSpkiDer(rawPoint);

    const verifier = createVerify("sha256");
    verifier.update(payloadBuf);
    verifier.end();

    return verifier.verify(
      { key: spkiDer, format: "der", type: "spki" },
      sigBuf,
    );
  } catch {
    return false;
  }
}

/**
 * Sign a payload with a P-256 private key and return the DER-encoded
 * ECDSA signature as a hex string.
 *
 * Intended for testing and tooling (e.g. generating test orders).
 *
 * @param privateKeyHex 32-byte P-256 private key (hex, 64 chars).
 * @param payload       The plaintext to sign (utf-8 string).
 * @returns             DER-encoded ECDSA signature (hex).
 */
export function hashAndSign(privateKeyHex: string, payload: string): string {
  const privateKey = Buffer.from(privateKeyHex, "hex");
  if (privateKey.length !== 32) {
    throw new Error("P-256 private key must be exactly 32 bytes (64 hex chars)");
  }

  const payloadBuf = Buffer.from(payload, "utf-8");
  const pkcs8Der = buildPkcs8Der(privateKey);

  const signer = createSign("sha256");
  signer.update(payloadBuf);
  signer.end();

  return signer.sign({ key: pkcs8Der, format: "der", type: "pkcs8" }).toString("hex");
}
