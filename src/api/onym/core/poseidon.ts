import { bls12_381_Fr as Fr } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { toHex, utf8 } from './bytes';

// Onym's Poseidon over the BLS12-381 scalar field (onym-contracts `plonk/prover/src/circuit/plonk/poseidon.rs`):
// width 3 (capacity 1, rate 2), 4 + 4 full rounds around 56 partial ones, S-box x^5, round constants chained from a
// SHA-256 seed, Cauchy MDS `1 / (i + j + 5)`, driven as the arkworks v0.5 sponge
const WIDTH = 3;
const FULL_ROUNDS = 8;
const PARTIAL_ROUNDS = 56;
const CONSTANTS_LABEL = 'SEP-XXXX-Poseidon-BLS12-381-w3-f8-p56-a5-round-constants';
const FR_BYTES = 32;

let roundConstants: bigint[][] | undefined;
let mds: bigint[][] | undefined;

export function hashOne(input: bigint) {
  return permute([0n, input, 0n])[1];
}

export function hashTwo(left: bigint, right: bigint) {
  return permute([0n, left, right])[1];
}

// `Common.leafHash`: Poseidon of the BLS secret read big-endian mod r
export function computeLeafHash(blsSecretKey: Uint8Array) {
  return frToBytes(hashOne(frFromBeBytes(blsSecretKey)));
}

// `Common.merkleRoot`: leaves zero-padded to 2^depth, heap-ordered nodes, root at index 1
export function computeMerkleRoot(leafHashes: Uint8Array[], depth: number) {
  const leafCount = 1 << depth;
  if (leafHashes.length > leafCount) throw new Error(`${leafHashes.length} leaves exceed depth ${depth}`);

  const nodes = new Array<bigint>(2 * leafCount).fill(0n);
  leafHashes.forEach((leaf, i) => {
    nodes[leafCount + i] = frFromBeBytes(leaf);
  });
  for (let i = leafCount - 1; i >= 1; i--) {
    nodes[i] = hashTwo(nodes[2 * i], nodes[2 * i + 1]);
  }
  return frToBytes(nodes[1]);
}

// `Common.poseidonCommitment`: H(H(root, epoch), salt), with the salt read little-endian mod r
export function computeCommitment(root: Uint8Array, epoch: bigint, salt: Uint8Array) {
  if (salt.length !== FR_BYTES) throw new Error('Salt must be 32 bytes');
  const inner = hashTwo(frFromBeBytes(root), Fr.create(epoch));
  return frToBytes(hashTwo(inner, frFromBeBytes(salt.slice().reverse())));
}

export function frFromBeBytes(bytes: Uint8Array) {
  if (bytes.length !== FR_BYTES) throw new Error('Field element must be 32 bytes');
  return Fr.create(BigInt(`0x${toHex(bytes)}`));
}

export function frToBytes(value: bigint) {
  const hex = value.toString(16).padStart(FR_BYTES * 2, '0');
  return Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
}

function permute(input: bigint[]) {
  const ark = getRoundConstants();
  const matrix = getMds();
  let state = input.map((value) => Fr.create(value));
  const halfFull = FULL_ROUNDS / 2;

  for (let round = 0; round < FULL_ROUNDS + PARTIAL_ROUNDS; round++) {
    const isFull = round < halfFull || round >= halfFull + PARTIAL_ROUNDS;
    state = state.map((value, i) => Fr.add(value, ark[round][i]));
    state = state.map((value, i) => (isFull || i === 0 ? Fr.pow(value, 5n) : value));
    state = matrix.map((row) => row.reduce((sum, coefficient, j) => Fr.add(sum, Fr.mul(coefficient, state[j])), 0n));
  }
  return state;
}

function getRoundConstants() {
  if (!roundConstants) {
    const flat: bigint[] = [];
    let seed = sha256(utf8(CONSTANTS_LABEL));
    for (let k = 0; k < (FULL_ROUNDS + PARTIAL_ROUNDS) * WIDTH; k++) {
      const extended = new Uint8Array(2 * FR_BYTES);
      extended.set(seed, 0);
      seed = sha256(seed);
      extended.set(seed, FR_BYTES);
      seed = sha256(seed);
      flat.push(Fr.create(BigInt(`0x${toHex(extended.reverse())}`)));
    }
    roundConstants = [];
    for (let i = 0; i < flat.length; i += WIDTH) roundConstants.push(flat.slice(i, i + WIDTH));
  }
  return roundConstants;
}

function getMds() {
  mds ??= Array.from({ length: WIDTH }, (_, i) => Array.from(
    { length: WIDTH }, (__, j) => Fr.inv(BigInt(i + 1 + WIDTH + j + 1)),
  ));
  return mds;
}
