import { generateOAuthState, isValidOAuthState } from '../web/oauthState';

describe('generateOAuthState', () => {
  it('returns a 32-character hex string', () => {
    expect(generateOAuthState()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns a different value on each call', () => {
    expect(generateOAuthState()).not.toBe(generateOAuthState());
  });
});

describe('isValidOAuthState', () => {
  it('accepts an exact match', () => {
    expect(isValidOAuthState('abc123', 'abc123')).toBe(true);
  });

  it('rejects a mismatch', () => {
    expect(isValidOAuthState('abc123', 'xyz789')).toBe(false);
  });

  it('rejects when either side is missing', () => {
    expect(isValidOAuthState(undefined, 'abc123')).toBe(false);
    expect(isValidOAuthState('abc123', undefined)).toBe(false);
    expect(isValidOAuthState('', 'abc123')).toBe(false);
  });

  it('rejects non-string actual values (e.g. a repeated query param)', () => {
    expect(isValidOAuthState(['abc123'], 'abc123')).toBe(false);
    expect(isValidOAuthState(123, '123')).toBe(false);
  });
});
