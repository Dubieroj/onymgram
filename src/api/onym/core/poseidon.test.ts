import { describe, expect, it } from 'vitest';

import { toHex } from './bytes';
import {
  computeCommitment, computeLeafHash, computeMerkleRoot, frToBytes,
} from './poseidon';

describe('poseidon', () => {
  // onym-contracts `build_canonical_membership_witness(5)`, pinned by `plonk/verifier/tests/fixtures/pi-d5.bin`
  it('reproduces the canonical depth-5 commitment', () => {
    const leaves = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n].map((secret) => computeLeafHash(frToBytes(secret)));
    const root = computeMerkleRoot(leaves, 5);
    const commitment = computeCommitment(root, 1234n, new Uint8Array(32).fill(0xee));
    expect(toHex(commitment)).toBe('66d6ca2b0096160993f6ffc7d93ef2d0ef617a0b5c2b6501ac55ff4891ee78be');
  });
});
