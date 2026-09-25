import type { ApiPeerColors } from '../../types';

// Telegram's server tunes its colour palettes; Onym has none, so peers get the UI's seven classic colours
const PALETTE_HASH = 1;
const CLASSIC_COLORS = ['#D45246', '#F68136', '#6C61DF', '#46BA43', '#5CAFFA', '#408ACF', '#D95574'];

export function fetchPeerColors() {
  const colors: ApiPeerColors['general'] = Object.fromEntries(
    CLASSIC_COLORS.map((color, i) => [i, { colors: [color] }]),
  );
  return Promise.resolve({ colors, hash: PALETTE_HASH });
}

export function fetchPeerProfileColors() {
  return Promise.resolve({ colors: {}, hash: PALETTE_HASH });
}
