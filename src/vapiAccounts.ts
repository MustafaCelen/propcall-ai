// PropCall AI — Vapi HESABI bazlı hat kapasitesi.
//
// Vapi'nin eşzamanlı arama sınırı KULLANICI başına değil, HESAP (API anahtarı) başına
// uygulanır (varsayılan plan: 10). Birden fazla danışman aynı Vapi hesabını paylaşır
// (merkezi anahtar ile otomatik provizyon edilenler) ya da ayrı hesap kullanır
// (örn. Zeynep/Emin'in kendi hesabı). Ürünleşme için kapasite yönetimi bu yüzden
// hesap bazlı olmalı: her hesabın kendi tavanı, tavanın hesabı paylaşan danışmanlar
// arasında ADİL paylaşımı (bkz. campaign.ts fairShareAllocation).
//
// Hesap kimliği: API anahtarının SHA-256 özetinin ilk 16 hex karakteri. Anahtar
// hiçbir yerde düz metin tutulmaz; admin panelinde yalnızca son 4 karakter ipucu
// gösterilir. Aynı anahtarı taşıyan tüm kullanıcılar otomatik olarak aynı hesaba düşer —
// ekstra bir "hesap seç" adımı gerekmez.

import { createHash } from 'crypto';
import pool from './db';
import { decryptSecret } from './crypto';

export const DEFAULT_VAPI_ACCOUNT_MAX_CONCURRENT = 10;

export interface VapiAccountInfo {
  key: string;
  label: string | null;
  apiKeyHint: string;
  maxConcurrent: number;
}

export function vapiAccountKeyFromApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function hintFromApiKey(apiKey: string): string {
  return '…' + apiKey.slice(-4);
}

// Kampanya motoru her tick'te (5-15sn) her kampanya için sorar — DB'ye her seferinde
// gitmemek için kısa süreli bellek içi önbellek. Admin tavanı/etiketi değiştirince
// invalidateVapiAccountCache ile temizlenir; anahtar değişimi de 60sn içinde yansır.
const CACHE_TTL_MS = 60 * 1000;
const userCache = new Map<string, { info: VapiAccountInfo | null; ts: number }>();

export function invalidateVapiAccountCache(): void {
  userCache.clear();
}

async function upsertAccount(apiKey: string): Promise<VapiAccountInfo> {
  const key = vapiAccountKeyFromApiKey(apiKey);
  const hint = hintFromApiKey(apiKey);
  const { rows } = await pool.query(
    `INSERT INTO vapi_accounts (account_key, api_key_hint, max_concurrent)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_key) DO UPDATE SET api_key_hint = EXCLUDED.api_key_hint
     RETURNING account_key, label, api_key_hint, max_concurrent`,
    [key, hint, DEFAULT_VAPI_ACCOUNT_MAX_CONCURRENT],
  );
  const r = rows[0];
  return { key: r.account_key, label: r.label, apiKeyHint: r.api_key_hint, maxConcurrent: r.max_concurrent };
}

// Kullanıcının bağlı olduğu Vapi hesabı (anahtarı yoksa null).
export async function resolveVapiAccountForUser(userId: string): Promise<VapiAccountInfo | null> {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.info;
  const { rows } = await pool.query(`SELECT vapi_api_key_enc FROM users WHERE id = $1`, [userId]);
  const enc = rows[0]?.vapi_api_key_enc;
  const info = enc ? await upsertAccount(decryptSecret(enc)) : null;
  userCache.set(userId, { info, ts: Date.now() });
  return info;
}

export interface VapiAccountAdminRow extends VapiAccountInfo {
  users: Array<{ id: string; name: string | null; email: string; isActive: boolean; maxConcurrentCalls: number }>;
}

// Admin paneli: tüm hesaplar + her hesaba bağlı danışmanlar. Anahtarlar burada
// yalnızca gruplamak için bellekte çözülür, yanıta asla yazılmaz.
export async function listVapiAccountsForAdmin(): Promise<VapiAccountAdminRow[]> {
  const { rows: users } = await pool.query(
    `SELECT id, name, email, is_active, max_concurrent_calls, vapi_api_key_enc FROM users
     WHERE vapi_api_key_enc IS NOT NULL ORDER BY name NULLS LAST, email`,
  );
  const byKey = new Map<string, VapiAccountAdminRow>();
  for (const u of users) {
    let apiKey: string;
    try { apiKey = decryptSecret(u.vapi_api_key_enc); } catch { continue; }
    const info = await upsertAccount(apiKey);
    let row = byKey.get(info.key);
    if (!row) { row = { ...info, users: [] }; byKey.set(info.key, row); }
    row.users.push({ id: u.id, name: u.name, email: u.email, isActive: u.is_active, maxConcurrentCalls: u.max_concurrent_calls });
  }
  // Artık hiçbir kullanıcının bağlı olmadığı (anahtarı değişmiş) hesaplar da listelensin —
  // admin eski kaydı görüp etiketinden tanıyabilsin.
  const { rows: all } = await pool.query(`SELECT account_key, label, api_key_hint, max_concurrent FROM vapi_accounts ORDER BY created_at`);
  const out: VapiAccountAdminRow[] = [];
  for (const r of all) {
    const row = byKey.get(r.account_key);
    out.push(row ?? { key: r.account_key, label: r.label, apiKeyHint: r.api_key_hint, maxConcurrent: r.max_concurrent, users: [] });
  }
  return out;
}

export async function updateVapiAccount(key: string, patch: { label?: string | null; maxConcurrent?: number }): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [key];
  if (patch.label !== undefined)         { vals.push(patch.label?.trim() || null); sets.push(`label = $${vals.length}`); }
  if (patch.maxConcurrent !== undefined) { vals.push(patch.maxConcurrent);         sets.push(`max_concurrent = $${vals.length}`); }
  if (!sets.length) return true;
  const { rowCount } = await pool.query(`UPDATE vapi_accounts SET ${sets.join(', ')} WHERE account_key = $1`, vals);
  invalidateVapiAccountCache();
  return (rowCount ?? 0) > 0;
}
