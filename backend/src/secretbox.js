'use strict';
// Encrypt secrets that must be recoverable in plaintext later (a share password
// has to be handed to `net use` verbatim, so it cannot be hashed).
//
// The key is derived from JWT_SECRET, which lives in backend/.env or in
// data/jwt.secret (mode 0600) — deliberately NOT in webmanager.db. So a copied
// database alone yields nothing: an attacker needs the key file too.
//
// AES-256-GCM: the auth tag makes a tampered or wrong-key ciphertext fail loudly
// instead of decrypting to garbage that would then be typed at a login prompt.
const crypto = require('crypto');
const config = require('./config');

const MAGIC = 'v1'; // lets the format change later without guessing
let cachedKey = null;

function key() {
  if (!cachedKey) {
    // Fixed salt: the input is already a high-entropy secret, and the value must
    // stay derivable across restarts without storing anything extra.
    cachedKey = crypto.scryptSync(String(config.JWT_SECRET), 'webmanager-secretbox', 32);
  }
  return cachedKey;
}

// -> "v1:<iv b64>:<tag b64>:<ciphertext b64>"
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [MAGIC, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

// Returns null when the value is unreadable (rotated JWT_SECRET, corrupted row)
// rather than throwing — the caller reports "re-enter the password" instead of
// crashing a reconnect loop.
function decrypt(blob) {
  try {
    const [magic, ivB64, tagB64, dataB64] = String(blob || '').split(':');
    if (magic !== MAGIC || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
