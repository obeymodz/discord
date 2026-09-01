// Generates the ECDSA P-256 keypair for response signing.
//
//   node gen-keys.js
//
// Prints two things:
//   1. SIGN_KEY  -> set as an env var on the server (Railway Variables tab).
//                   This is the PRIVATE key. Never commit it, never ship it.
//   2. A 64-byte public key, formatted as a C++ array -> paste into
//      remote.h's g_ServerPubKey. This is the PUBLIC key; it is safe in the DLL.
//
// Run it once. Re-running makes a NEW pair and invalidates every deployed
// client, so keep the output somewhere safe.

import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1', // == secp256r1 == NIST P-256
});

// Private key as one-line PEM (newlines escaped) for an env var.
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const envLine = pem.replace(/\n/g, '\\n');

// Public key raw point: JWK gives x and y as base64url; concat -> 64 bytes.
const jwk = publicKey.export({ format: 'jwk' });
const x = Buffer.from(jwk.x, 'base64url');
const y = Buffer.from(jwk.y, 'base64url');
const raw = Buffer.concat([x, y]); // X||Y, 64 bytes

const cppRows = [];
for (let i = 0; i < raw.length; i += 8) {
  const row = [...raw.subarray(i, i + 8)]
    .map((b) => '0x' + b.toString(16).padStart(2, '0'))
    .join(',');
  cppRows.push('        ' + row + ',');
}

console.log('\n=== 1. SERVER: set this env var (Railway -> Variables) ===\n');
console.log('SIGN_KEY=' + envLine);

console.log('\n=== 2. CLIENT: paste into remote.h  g_ServerPubKey[64] ===\n');
console.log('    inline const uint8_t g_ServerPubKey[64] = {');
console.log(cppRows.join('\n'));
console.log('    };');
console.log('\nKeep the SIGN_KEY secret. The public array is safe to ship.\n');
