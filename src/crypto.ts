// AES-256-GCM envelope encryption — admin panelden girilen API key'leri için

import crypto from 'crypto';

const ALG = 'aes-256-gcm';

function getMasterKey(): Buffer {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) throw new Error('SECRET_ENCRYPTION_KEY tanımlanmamış — 32 byte base64 (bkz. .env.example)');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SECRET_ENCRYPTION_KEY 32 byte olmalı (base64 encoded)');
  return key;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, getMasterKey(), iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  // Format: iv|tag|ciphertext (base64)
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(encoded: string): string {
  if (!encoded) return '';
  const buf = Buffer.from(encoded, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALG, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// Utility — .env için yeni master key üretir (bir kerelik setup)
export function generateMasterKey(): string {
  return crypto.randomBytes(32).toString('base64');
}
