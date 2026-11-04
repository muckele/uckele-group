// AES-256-GCM encryption of the Gmail refresh token at rest.
// Format: v1.<iv base64>.<tag base64>.<ciphertext base64>. Errors carry only a code,
// never the key, the token or the ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from('deal-hunter-gmail-refresh-token-v1');
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

function keyInvalid() {
  const error = new Error('gmail_token_key_invalid');
  error.code = 'gmail_token_key_invalid';
  return error;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !base64Pattern.test(value)) throw keyInvalid();
  return Buffer.from(value, 'base64');
}

/** Decodes the 32-byte base64 key; anything else is gmail_token_key_invalid. */
export function decodeGmailTokenKey(keyBase64) {
  const key = decodeBase64(String(keyBase64 ?? '').trim());
  if (key.length !== 32) throw keyInvalid();
  return key;
}

export function encryptRefreshToken(plaintext, keyBase64) {
  const key = decodeGmailTokenKey(keyBase64);
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new Error('Invalid refreshToken');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64')].join('.');
}

export function decryptRefreshToken(ciphertext, keyBase64) {
  const key = decodeGmailTokenKey(keyBase64);
  const parts = typeof ciphertext === 'string' ? ciphertext.split('.') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw keyInvalid();
  const iv = decodeBase64(parts[1]);
  const tag = decodeBase64(parts[2]);
  const body = decodeBase64(parts[3]);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw keyInvalid();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw keyInvalid();
  }
}
