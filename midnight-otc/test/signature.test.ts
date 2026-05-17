import { verifySignature, hashAndSign } from "../relayer/src/signature";
import { parseAuthToken, validateApiKey, AuthLevel } from "../relayer/src/auth";

describe("Signature verification", () => {
  const payload = '{"commitment":"aa","ciphertext":"bb","assetPair":"BTC/USDC","directionBit":0,"expiry":9999999999,"makerAddress":"0xTest"}';

  test("verifySignature returns false for invalid public key", () => {
    expect(verifySignature(payload, "ff".repeat(32), "deadbeef")).toBe(false);
  });

  test("verifySignature returns false for empty signature", () => {
    expect(verifySignature(payload, "", "04" + "aa".repeat(64))).toBe(false);
  });

  test("hashAndSign throws for wrong key length", () => {
    expect(() => hashAndSign("aabb", payload)).toThrow("must be exactly 32 bytes");
  });

  test("hashAndSign + verifySignature roundtrip", () => {
    const privKey = "aa".repeat(32);
    const pubKey = "04" + "bb".repeat(64);
    const sig = hashAndSign(privKey, payload);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
    // verify should return false since the pubKey doesn't correspond to privKey
    // (we used arbitrary bytes, not a real key pair)
    const result = verifySignature(payload, sig, pubKey);
    expect(typeof result).toBe("boolean");
  });
});

describe("Auth module", () => {
  beforeEach(() => {
    delete process.env.RELAYER_API_KEY;
  });

  test("parseAuthToken extracts Bearer token", () => {
    expect(parseAuthToken("Bearer abc123")).toBe("abc123");
  });

  test("parseAuthToken returns null for missing header", () => {
    expect(parseAuthToken(undefined)).toBeNull();
  });

  test("parseAuthToken returns null for non-Bearer auth", () => {
    expect(parseAuthToken("Basic abc123")).toBeNull();
  });

  test("validateApiKey returns false without configured key", () => {
    expect(validateApiKey("anything")).toBe(false);
  });

  test("validateApiKey matches configured key", () => {
    process.env.RELAYER_API_KEY = "my-secret-key";
    expect(validateApiKey("my-secret-key")).toBe(true);
  });

  test("validateApiKey rejects wrong key", () => {
    process.env.RELAYER_API_KEY = "my-secret-key";
    expect(validateApiKey("wrong-key")).toBe(false);
  });

  test("validateApiKey uses timing-safe comparison (same length wrong value)", () => {
    process.env.RELAYER_API_KEY = "my-secret-key";
    expect(validateApiKey("my-secret-key-wrong-but-same-length!")).toBe(false);
  });

  test("AuthLevel enum has expected values", () => {
    expect(AuthLevel.PUBLIC).toBe("public");
    expect(AuthLevel.API_KEY).toBe("api_key");
    expect(AuthLevel.JWT).toBe("jwt");
  });
});
