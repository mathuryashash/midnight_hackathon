/**
 * Contract client — bridges frontend to the Midnight smart contract.
 *
 * Two modes:
 *  - MOCK: full in-browser simulation, no wallet or blockchain needed
 *  - MIDNIGHT: real Midnight testnet via Lace wallet + Midnight JS SDK
 *
 * Switch via NEXT_PUBLIC_USE_MOCK=true in .env
 */

import type {
  OnChainCommitment,
  RevealPayload,
  SettlementResult,
} from "../../../shared/types";
import { buildCommitmentInput, bufToHex } from "./crypto";

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

// ─── Mock State (in-memory, browser session only) ─────────────────────────────

interface MockState {
  commitments: Map<string, OnChainCommitment>;
  balances: Map<string, Map<string, bigint>>; // address -> token -> amount
  blockTime: number;
}

const mockState: MockState = {
  commitments: new Map(),
  balances: new Map(),
  blockTime: Math.floor(Date.now() / 1000),
};

// Pre-seed mock commitments for the hardcoded orders in the taker page
// so revealAndMatch finds them during settlement
if (USE_MOCK) {
  const MOCK_ORDER_IDS = ["ord-001", "ord-002", "ord-003"];
  const MOCK_MAKERS = [
    "0xMaker1a2b3c4d5e6f7a8b9c0d1e2f3",
    "0xMaker9f8e7d6c5b4a3e2d1c0b9a8f7e6d5",
    "0xMaker3c4d5e6f7a8b9c0d1e2f3a4b5c6",
  ];
  for (let i = 0; i < MOCK_ORDER_IDS.length; i++) {
    mockState.commitments.set(MOCK_ORDER_IDS[i], {
      maker: MOCK_MAKERS[i],
      ciphertextHash: "0x" + "a".repeat(64),
      deadline: Math.floor(Date.now() / 1000) + 86400 * 7,
      feeDeposit: BigInt(10_000),
      tokenIn: i === 1 ? "ETH" : "BTC",
      tokenOut: "USDC",
      escrowed: BigInt(500_000),
      filled: false,
      cancelled: false,
    });
  }
}

// Seed mock balances so demo works out of the box
function initMockBalances(address: string) {
  if (!mockState.balances.has(address)) {
    mockState.balances.set(
      address,
      new Map([
        ["BTC", BigInt(5_000_000)],    // 5 BTC (in satoshis or similar)
        ["USDC", BigInt(250_000_000)], // 250,000 USDC (in microdollars)
        ["ETH", BigInt(50_000_000)],   // 50 ETH
        ["DUST", BigInt(1_000_000)],   // 1M DUST for fees
      ])
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CommitOrderParams {
  ciphertextHash: string;
  deadline: number;
  tokenIn: string;
  tokenOut: string;
  escrowedAmount: bigint;
  directionBit: 0 | 1;
  feeDeposit: bigint;
  makerAddress: string;
}

/**
 * Post an encrypted order commitment to the blockchain.
 * Returns the on-chain order key (a hash).
 */
export async function commitOrder(params: CommitOrderParams): Promise<string> {
  if (USE_MOCK) {
    return mockCommitOrder(params);
  }
  return midnightCommitOrder(params);
}

/**
 * Reveal and settle an order atomically.
 */
export async function revealAndMatch(
  orderKey: string,
  reveal: RevealPayload
): Promise<SettlementResult> {
  if (USE_MOCK) {
    return mockRevealAndMatch(orderKey, reveal);
  }
  return midnightRevealAndMatch(orderKey, reveal);
}

/**
 * Cancel an order and recover escrowed funds.
 */
export async function cancelOrder(
  orderKey: string,
  makerAddress: string
): Promise<SettlementResult> {
  if (USE_MOCK) {
    return mockCancelOrder(orderKey, makerAddress);
  }
  return midnightCancelOrder(orderKey, makerAddress);
}

/**
 * Fetch an order commitment from the blockchain.
 */
export async function getCommitment(
  orderKey: string
): Promise<OnChainCommitment | null> {
  if (USE_MOCK) {
    return mockState.commitments.get(orderKey) ?? null;
  }
  return midnightGetCommitment(orderKey);
}

/**
 * Get token balance for an address.
 */
export async function getBalance(
  address: string,
  token: string
): Promise<bigint> {
  if (USE_MOCK) {
    initMockBalances(address);
    return mockState.balances.get(address)?.get(token) ?? BigInt(0);
  }
  return midnightGetBalance(address, token);
}

// ─── Mock Implementations ─────────────────────────────────────────────────────

async function mockCommitOrder(params: CommitOrderParams): Promise<string> {
  await simulateDelay(800);

  initMockBalances(params.makerAddress);
  const balance = mockState.balances
    .get(params.makerAddress)
    ?.get(params.tokenIn) ?? BigInt(0);

  if (balance < params.escrowedAmount) {
    throw new Error(`Insufficient ${params.tokenIn} balance for escrow`);
  }

  // Derive order key: SHA-256(ciphertextHash ++ makerAddress) — simplified mock
  const orderKey = await hashStrings(params.ciphertextHash, params.makerAddress);

  if (mockState.commitments.has(orderKey)) {
    throw new Error("Duplicate commitment — regenerate your order nonce");
  }

  // Lock escrowed amount
  const addr = params.makerAddress;
  const bal = mockState.balances.get(addr)!;
  bal.set(params.tokenIn, balance - params.escrowedAmount);

  mockState.commitments.set(orderKey, {
    maker: params.makerAddress,
    ciphertextHash: params.ciphertextHash,
    deadline: params.deadline,
    feeDeposit: params.feeDeposit,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    escrowed: params.escrowedAmount,
    filled: false,
    cancelled: false,
  });

  return orderKey;
}

async function mockRevealAndMatch(
  orderKey: string,
  reveal: RevealPayload
): Promise<SettlementResult> {
  await simulateDelay(1200);

  const commitment = mockState.commitments.get(orderKey);
  if (!commitment) return { success: false, error: "Order not found" };
  if (commitment.filled) return { success: false, error: "Order already filled" };
  if (commitment.cancelled) return { success: false, error: "Order cancelled" };
  if (commitment.deadline < Math.floor(Date.now() / 1000)) {
    return { success: false, error: "Order expired" };
  }

  // Verify taker credential proof
  if (!isValidCredentialProof(reveal.takerCredentialProof)) {
    return { success: false, error: "Invalid taker credential proof" };
  }

  // Verify commitment hash — SHA-256(ciphertext || iv || authTag || salt) (length-prefixed)
  if (reveal.ciphertext !== "[AES-256-GCM encrypted — price and size hidden]") {
    const computedHash = await hashStrings(
      reveal.ciphertext,
      reveal.iv,
      reveal.authTag,
      reveal.salt
    );

    if (computedHash !== commitment.ciphertextHash) {
      return { success: false, error: "Commitment mismatch — reveal data does not match on-chain hash" };
    }
  }

  // Simulate atomic settlement
  initMockBalances(reveal.takerAddress);
  const takerBal = mockState.balances.get(reveal.takerAddress)!;
  const currentTakerBalance = takerBal.get(commitment.tokenIn) ?? BigInt(0);
  takerBal.set(commitment.tokenIn, currentTakerBalance + commitment.escrowed);

  // Mark filled
  mockState.commitments.set(orderKey, {
    ...commitment,
    filled: true,
  });

  const fakeTxHash = await hashStrings(orderKey, Date.now().toString());
  return {
    success: true,
    txHash: `0x${fakeTxHash.slice(0, 64)}`,
    takerReceived: commitment.escrowed,
    makerReceived: commitment.escrowed, // Mock: same amount for simplicity
  };
}

async function mockCancelOrder(
  orderKey: string,
  makerAddress: string
): Promise<SettlementResult> {
  await simulateDelay(600);

  const commitment = mockState.commitments.get(orderKey);
  if (!commitment) return { success: false, error: "Order not found" };
  if (commitment.maker !== makerAddress) {
    return { success: false, error: "Only maker can cancel" };
  }
  if (commitment.filled) return { success: false, error: "Cannot cancel filled order" };
  if (commitment.cancelled) return { success: false, error: "Already cancelled" };
  if (commitment.deadline < Math.floor(Date.now() / 1000)) {
    return { success: false, error: "Cannot cancel after expiry — order already timed out" };
  }

  // Return escrowed tokens
  initMockBalances(makerAddress);
  const bal = mockState.balances.get(makerAddress)!;
  const current = bal.get(commitment.tokenIn) ?? BigInt(0);
  bal.set(commitment.tokenIn, current + commitment.escrowed);

  mockState.commitments.set(orderKey, { ...commitment, cancelled: true });

  const fakeTxHash = await hashStrings(orderKey, "cancel");
  return {
    success: true,
    txHash: `0x${fakeTxHash.slice(0, 64)}`,
    makerReceived: commitment.escrowed,
  };
}

// ─── Real Midnight Implementations ───────────────────────────────────────────
// These use the Midnight JS SDK. Uncomment and adapt once you have:
//   1. Lace wallet installed with Midnight support
//   2. Midnight testnet access
//   3. Contract deployed (npm run deploy:testnet in /contracts)

async function midnightCommitOrder(
  params: CommitOrderParams
): Promise<string> {
  // const { MidnightProvider } = await import("@midnight-ntwrk/midnight-js-contracts");
  // const contract = await MidnightProvider.getContract(CONTRACT_ADDRESS);
  // const tx = await contract.commitOrder(
  //   params.ciphertextHash,
  //   params.deadline,
  //   params.tokenIn,
  //   params.tokenOut,
  //   params.escrowedAmount,
  //   params.directionBit,
  //   params.feeDeposit
  // );
  // await tx.wait();
  // return tx.orderKey;
  throw new Error(
    "Midnight integration not yet configured. Set NEXT_PUBLIC_USE_MOCK=true or complete Midnight setup."
  );
}

async function midnightRevealAndMatch(
  _orderKey: string,
  _reveal: RevealPayload
): Promise<SettlementResult> {
  throw new Error("Midnight integration not yet configured.");
}

async function midnightCancelOrder(
  _orderKey: string,
  _makerAddress: string
): Promise<SettlementResult> {
  throw new Error("Midnight integration not yet configured.");
}

async function midnightGetCommitment(
  _orderKey: string
): Promise<OnChainCommitment | null> {
  throw new Error("Midnight integration not yet configured.");
}

async function midnightGetBalance(
  _address: string,
  _token: string
): Promise<bigint> {
  throw new Error("Midnight integration not yet configured.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function hashStrings(...parts: string[]): Promise<string> {
  const input = buildCommitmentInput(...parts);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return bufToHex(new Uint8Array(hash));
}

function isValidCredentialProof(proof: string): boolean {
  return proof === "verified" || proof.startsWith("vc:");
}

function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const CONTRACT_MODE = USE_MOCK ? "mock" : "midnight";
