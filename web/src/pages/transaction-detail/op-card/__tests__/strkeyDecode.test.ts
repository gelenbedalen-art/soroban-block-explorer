import { describe, expect, it } from 'vitest';

import { contractOfMuxed } from '../strkeyDecode.js';

// A mainnet contract and the same contract with sub-account id 42
// (CAP-0084), as stellar-strkey 1.0 encodes it.
const REAL_C = 'CDL74RF5BLYR2YBLCCI7F5FB6TPSCLKEJUBSD2RSVWZ4YHF3VMFAIGWA';
const REAL_W =
  'WDL74RF5BLYR2YBLCCI7F5FB6TPSCLKEJUBSD2RSVWZ4YHF3VMFAIAAAAAAAAAAAFLR56';

describe('contractOfMuxed', () => {
  it('names the contract a W-strkey belongs to', () => {
    expect(contractOfMuxed(REAL_W)).toBe(REAL_C);
  });

  it('is null for anything but a valid W-strkey', () => {
    expect(contractOfMuxed(REAL_C)).toBeNull();
    expect(contractOfMuxed('W')).toBeNull();
    expect(contractOfMuxed(REAL_W.toLowerCase())).toBeNull();
    // One changed character breaks the checksum.
    const broken =
      REAL_W.slice(0, 10) + (REAL_W[10] === 'A' ? 'B' : 'A') + REAL_W.slice(11);
    expect(contractOfMuxed(broken)).toBeNull();
  });
});
