/**
 * WebSocket integration tests for the relayer.
 *
 * The relayer server auto-starts when its module is imported
 * (httpServer.listen() runs at module scope). We set RELAYER_PORT
 * before importing so the server binds to the test port.
 * The process exits with --forceExit since the server stays alive.
 */

import WebSocket from "ws";
import { createECDH, randomBytes } from "crypto";
import { hashAndSign } from "../relayer/src/signature";

const RELAYER_URL = "ws://0.0.0.0:3099";

jest.setTimeout(15_000);

beforeAll(async () => {
  process.env.RELAYER_PORT = "3099";
  process.env.LOG_LEVEL = "fatal";

  jest.isolateModules(() => {
    require("../relayer/src/index");
  });

  for (let i = 0; i < 30; i++) {
    try {
      const ws = new WebSocket(RELAYER_URL);
      await new Promise<void>((ok, err) => {
        ws.once("open", () => { ws.close(); ok(); });
        ws.once("error", err);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Server did not start");
});

function makeOrder(): Record<string, any> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey("hex");
  const privateKey = ecdh.getPrivateKey("hex");

  const commitment = randomBytes(32).toString("hex");
  const order: Record<string, any> = {
    commitment,
    ciphertext: "bb".repeat(32),
    iv: "c".repeat(24),
    authTag: "d".repeat(32),
    salt: "e".repeat(64),
    assetPair: "BTC/USDC",
    directionBit: 0,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    makerAddress: "0xtestmaker",
    makerPublicKey: publicKey,
    signature: "",
  };

  const payloadForSig = JSON.stringify({
    commitment: order.commitment,
    ciphertext: order.ciphertext,
    assetPair: order.assetPair,
    directionBit: order.directionBit,
    expiry: order.expiry,
    makerAddress: order.makerAddress,
  });
  order.signature = hashAndSign(privateKey, payloadForSig);
  return order;
}

describe("WebSocket Relayer", () => {
  test("connects and receives orderbook snapshot", async () => {
    const ws = new WebSocket(RELAYER_URL);
    const msg = await new Promise<any>((resolve, reject) => {
      ws.once("error", (e) => reject(e));
      ws.once("open", () => { /* wait for message */ });
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
    expect(msg.type).toBe("orderbook:snapshot");
    expect(Array.isArray(msg.payload)).toBe(true);
    ws.close();
  });

  test("responds to ping with pong", async () => {
    const ws = new WebSocket(RELAYER_URL);
    await new Promise<any>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => { /* wait for message */ });
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });

    ws.send(JSON.stringify({ type: "ping" }));
    const msg = await new Promise<any>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
    expect(msg.type).toBe("error");
    expect(msg.payload.code).toBe("PONG");
    expect(msg.payload.message).toBe("pong");
    ws.close();
  });

  test("submits valid order and receives order:new broadcast", async () => {
    const order = makeOrder();
    const ws = new WebSocket(RELAYER_URL);

    await new Promise<any>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => { /* wait for message */ });
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });

    ws.send(JSON.stringify({ type: "order:submit", payload: order }));
    const msg = await new Promise<any>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });

    expect(msg.type).toBe("order:new");
    expect(msg.payload.commitment).toBe(order.commitment);
    expect(msg.payload.ciphertext).toBe(order.ciphertext);
    expect(msg.payload.assetPair).toBe("BTC/USDC");
    expect(msg.payload.directionBit).toBe(0);
    expect(msg.payload.makerAddress).toBe("0xtestmaker");
    expect(msg.payload.status).toBe("open");
    expect(typeof msg.payload.id).toBe("string");
    expect(typeof msg.payload.receivedAt).toBe("number");
    ws.close();
  });

  test("invalid JSON returns PARSE_ERROR", async () => {
    const ws = new WebSocket(RELAYER_URL);

    await new Promise<any>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => { /* wait for message */ });
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });

    ws.send("not valid json");
    const msg = await new Promise<any>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
    expect(msg.type).toBe("error");
    expect(msg.payload.code).toBe("PARSE_ERROR");
    ws.close();
  });

  test("unknown message type returns PARSE_ERROR", async () => {
    const ws = new WebSocket(RELAYER_URL);

    await new Promise<any>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => { /* wait for message */ });
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });

    ws.send(JSON.stringify({ type: "bogus" }));
    const msg = await new Promise<any>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
    expect(msg.type).toBe("error");
    expect(msg.payload.code).toBe("PARSE_ERROR");
    expect(msg.payload.message).toMatch(/discriminator/i);
    ws.close();
  });

  test("duplicate commitment returns DUPLICATE error", async () => {
    const order = makeOrder();
    const ws = new WebSocket(RELAYER_URL);

    await new Promise<any>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => { /* wait for message */ });
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });

    ws.send(JSON.stringify({ type: "order:submit", payload: order }));
    const msg1 = await new Promise<any>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
    expect(msg1.type).toBe("order:new");

    ws.send(JSON.stringify({ type: "order:submit", payload: order }));
    const msg2 = await new Promise<any>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
    expect(msg2.type).toBe("error");
    expect(msg2.payload.code).toBe("DUPLICATE");
    expect(msg2.payload.message).toMatch(/commitment/i);
    ws.close();
  });
});
