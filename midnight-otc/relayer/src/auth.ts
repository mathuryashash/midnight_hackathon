/**
 * Simple authentication / token-parsing module for the relayer.
 *
 * Supports optional Bearer-token auth on WebSocket and HTTP endpoints.
 * API key validation uses constant-time comparison to prevent timing attacks.
 */

import { timingSafeEqual } from "crypto";

export enum AuthLevel {
  /** Endpoint requires no authentication (e.g. health check). */
  PUBLIC = "public",
  /** Endpoint requires a valid API key via Bearer token. */
  API_KEY = "api_key",
  /** Reserved for future JWT-based auth. */
  JWT = "jwt",
}

/**
 * Extract a Bearer token from an Authorization header value.
 *
 * @param header The raw `Authorization` header value (e.g. `"Bearer abc123"`).
 * @returns The token string, or `null` if no valid Bearer token is found.
 */
export function parseAuthToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Validate a token against the configured API key.
 *
 * Reads the expected key from `process.env.RELAYER_API_KEY`.
 * Comparison uses `crypto.timingSafeEqual` to resist timing attacks.
 *
 * @param token The token to validate.
 * @returns `true` if the token matches the configured key.
 */
export function validateApiKey(token: string): boolean {
  const expected = process.env.RELAYER_API_KEY;
  if (!expected || !token) return false;
  if (token.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
