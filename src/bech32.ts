/**
 * npub → hex lives in `shared/bech32.js` (plain ES module shared by the
 * Worker and the browser UI). This file is the TS import shim.
 */
export { npubToHex } from '../shared/bech32.js';
