// Admin panelden yönetilen API key'leri — DB'de şifreli saklanır, yoksa .env'e düşer.
// Böylece restart gerektirmeden anlık key değişikliği yapılabilir.

import pool from './db';
import { encryptSecret, decryptSecret } from './crypto';

export const SETTINGS_KEYS = [
  'ANTHROPIC_API_KEY',
  'VAPI_API_KEY',
  'VAPI_PHONE_NUMBER_ID',
  'VAPI_ASSISTANT_ID',
  'ELEVENLABS_API_KEY',
] as const;
export type SettingsKey = typeof SETTINGS_KEYS[number];

// Gerçek gizli anahtarlar — admin panelde maskelenerek gösterilir.
// Diğerleri (phone/assistant ID) sır değil, açık gösterilir.
const SECRET_KEYS = new Set<SettingsKey>(['ANTHROPIC_API_KEY', 'VAPI_API_KEY', 'ELEVENLABS_API_KEY']);

let cache: Map<string, string> | null = null;

async function ensureCache(): Promise<Map<string, string>> {
  if (cache) return cache;
  const { rows } = await pool.query('SELECT key, value_enc FROM app_settings');
  const m = new Map<string, string>();
  for (const r of rows) {
    try { m.set(r.key, decryptSecret(r.value_enc)); }
    catch (err) { console.error(`[Settings] "${r.key}" çözülemedi (master key değişmiş olabilir):`, err); }
  }
  cache = m;
  return cache;
}

// DB'de admin panelden set edilmişse onu, yoksa .env değerini döndürür.
export async function getSetting(key: SettingsKey): Promise<string> {
  const c = await ensureCache();
  return c.get(key) || process.env[key] || '';
}

export async function setSetting(key: SettingsKey, value: string): Promise<void> {
  const c = await ensureCache();
  const enc = encryptSecret(value);
  await pool.query(
    `INSERT INTO app_settings (key, value_enc, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value_enc = $2, updated_at = NOW()`,
    [key, enc],
  );
  c.set(key, value);
}

export async function clearSetting(key: SettingsKey): Promise<void> {
  const c = await ensureCache();
  await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
  c.delete(key);
}

function maskValue(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}

export interface AdminSettingView {
  value: string;           // gizli anahtarlar maskeli, diğerleri açık
  source: 'db' | 'env' | 'none';
  masked: boolean;
  hasValue: boolean;
}

export async function getSettingsForAdmin(): Promise<Record<SettingsKey, AdminSettingView>> {
  const c = await ensureCache();
  const result = {} as Record<SettingsKey, AdminSettingView>;
  for (const key of SETTINGS_KEYS) {
    const dbVal  = c.get(key);
    const envVal = process.env[key];
    const raw    = dbVal || envVal || '';
    const source: AdminSettingView['source'] = dbVal ? 'db' : envVal ? 'env' : 'none';
    const masked = SECRET_KEYS.has(key);
    result[key] = {
      value: masked && raw ? maskValue(raw) : raw,
      source,
      masked,
      hasValue: !!raw,
    };
  }
  return result;
}
