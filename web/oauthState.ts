/**
 * CSRF protection for the GitHub OAuth flow. Pure — no Express or network
 * dependencies — so /api/auth/login and /api/auth/callback in server.ts can
 * generate and verify a `state` value without an attacker-forgeable redirect
 * completing the login on a victim's session.
 */
import crypto from 'node:crypto';

/** Generates a random, unguessable value to bind an OAuth redirect to its session. */
export function generateOAuthState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** True only when `actual` is a non-empty string exactly matching `expected`. */
export function isValidOAuthState(actual: unknown, expected: string | undefined): boolean {
  return typeof actual === 'string' && actual.length > 0 && actual === expected;
}
