// PropCall AI — Danışman (consultant) hesapları: CRUD + şifreli credential yönetimi.
// Şifre hash'leme ve oturum yönetimi src/auth.ts'te; bu dosya sadece veri erişimi.

import pool from './db';
import { encryptSecret, decryptSecret } from './crypto';

export type UserRole = 'agent' | 'admin';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  isActive: boolean;
  vapiPhoneNumberId: string | null;
  vapiAssistantId: string | null;
  vapiPublicKey: string | null;
  maxConcurrentCalls: number;
  callingHoursStart: number | null;
  callingHoursEnd: number | null;
  elevenLabsCostPer1k: number | null;
  balanceTry: number;
  companyName: string | null;
  fonzipUserId: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ResolvedVapiCredentials {
  apiKey: string;
  phoneNumberId: string;
  assistantId: string;
  serverSecret: string;
}

function newUserId(): string {
  return 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

const USER_COLUMNS =
  `id, email, name, role, is_active, vapi_phone_number_id, vapi_assistant_id, vapi_public_key, max_concurrent_calls,
   calling_hours_start, calling_hours_end, elevenlabs_cost_per_1k, balance_try, company_name, fonzip_user_id, last_login_at, created_at`;

function rowToUser(r: any): UserRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    isActive: r.is_active,
    vapiPhoneNumberId: r.vapi_phone_number_id,
    vapiAssistantId: r.vapi_assistant_id,
    vapiPublicKey: r.vapi_public_key,
    maxConcurrentCalls: r.max_concurrent_calls,
    callingHoursStart: r.calling_hours_start,
    callingHoursEnd: r.calling_hours_end,
    elevenLabsCostPer1k: r.elevenlabs_cost_per_1k != null ? Number(r.elevenlabs_cost_per_1k) : null,
    balanceTry: Number(r.balance_try ?? 0),
    companyName: r.company_name,
    fonzipUserId: r.fonzip_user_id != null ? Number(r.fonzip_user_id) : null,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function getUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email.toLowerCase().trim()]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

// Şifre doğrulama auth.ts'te yapılır — burada sadece hash + aktiflik durumu döner.
export async function getAuthRecord(email: string): Promise<{ id: string; passwordHash: string; isActive: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT id, password_hash, is_active FROM users WHERE email = $1`,
    [email.toLowerCase().trim()],
  );
  const r = rows[0];
  return r ? { id: r.id, passwordHash: r.password_hash, isActive: r.is_active } : null;
}

export async function createUser(params: {
  email: string; passwordHash: string; name?: string; role?: UserRole; companyName?: string;
}): Promise<UserRow> {
  const id = newUserId();
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, company_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${USER_COLUMNS}`,
    [id, params.email.toLowerCase().trim(), params.passwordHash, params.name || null, params.role || 'agent', params.companyName || null],
  );
  return rowToUser(rows[0]);
}

export async function setUserCompanyName(id: string, companyName: string | null): Promise<void> {
  await pool.query(`UPDATE users SET company_name = $2 WHERE id = $1`, [id, companyName?.trim() || null]);
}

export async function listUsers(): Promise<UserRow[]> {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`);
  return rows.map(rowToUser);
}

export async function setUserActive(id: string, active: boolean): Promise<void> {
  await pool.query(`UPDATE users SET is_active = $2 WHERE id = $1`, [id, active]);
}

export async function setUserPassword(id: string, passwordHash: string): Promise<void> {
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
}

export async function touchLastLogin(id: string): Promise<void> {
  await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [id]);
}

export async function setUserMaxConcurrent(id: string, max: number): Promise<void> {
  await pool.query(`UPDATE users SET max_concurrent_calls = $2 WHERE id = $1`, [id, max]);
}

// null geçmek "sınır yok" demektir — kampanya motoru gece/hafta sonu ayrımı yapmaz,
// sadece verilen saat aralığının dışında yeni arama başlatmayı durdurur.
export async function setUserCallingHours(id: string, start: number | null, end: number | null): Promise<void> {
  await pool.query(`UPDATE users SET calling_hours_start = $2, calling_hours_end = $3 WHERE id = $1`, [id, start, end]);
}

// Vapi'nin kendi maliyet raporu BYO ElevenLabs kullanıldığında TTS kalemini içermez
// (her zaman 0) — bu yüzden kullanıcının kendi ElevenLabs planındaki gerçek karakter
// başı ücreti buradan alınır, arama başına tahmini maliyet buna göre hesaplanır.
export async function setUserElevenLabsRate(id: string, costPer1k: number | null): Promise<void> {
  await pool.query(`UPDATE users SET elevenlabs_cost_per_1k = $2 WHERE id = $1`, [id, costPer1k]);
}

// ─── Jeton (TL bakiyesi) ────────────────────────────────────────────────────
// 1 jeton = 1 TL. Dakika başı ücret CALL_MINUTE_RATE_TRY — başlayan her dakika
// tam ücretlendirilir (çağrı merkezi standardı), aramanın gerçek süresine göre
// yukarı yuvarlanır. Her bakiye değişikliği credit_transactions'a kalıcı bir satır
// olarak yazılır — balance_try sadece hızlı okunabilir güncel toplam.
export const CALL_MINUTE_RATE_TRY = 20;

function newTxId(): string {
  return 'tx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export async function getUserBalance(userId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT balance_try FROM users WHERE id = $1`, [userId]);
  return rows[0] ? Number(rows[0].balance_try) : 0;
}

// Admin bakiye yükleme veya elle düzeltme — amount negatif de olabilir (hatalı
// yüklemeyi geri almak için). Dönüş: işlem sonrası güncel bakiye.
export async function adjustUserBalance(
  userId: string, amount: number, type: 'topup' | 'adjustment', note?: string,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO credit_transactions (id, user_id, amount, type, note) VALUES ($1, $2, $3, $4, $5)`,
      [newTxId(), userId, amount, type, note || null],
    );
    const { rows } = await client.query(
      `UPDATE users SET balance_try = balance_try + $2 WHERE id = $1 RETURNING balance_try`,
      [userId, amount],
    );
    await client.query('COMMIT');
    return Number(rows[0].balance_try);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Bir aramanın süresine göre bakiyeden düşer. Aynı vapiCallId için ikinci kez
// çağrılırsa (örn. bir deploy sırasında Vapi'nin webhook'u tekrar göndermesi)
// DB'deki partial unique index sayesinde sessizce hiçbir şey yapmaz — aynı arama
// asla iki kez ücretlendirilemez. Dönüş: gerçekten ücretlendirildiyse true.
export async function chargeForCall(userId: string, vapiCallId: string, durationSeconds: number): Promise<boolean> {
  const minutes = Math.ceil(durationSeconds / 60);
  if (minutes <= 0) return false;
  const amount = -(minutes * CALL_MINUTE_RATE_TRY);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO credit_transactions (id, user_id, amount, type, vapi_call_id, note)
       VALUES ($1, $2, $3, 'call_charge', $4, $5)
       ON CONFLICT (vapi_call_id) WHERE type = 'call_charge' DO NOTHING`,
      [newTxId(), userId, amount, vapiCallId, `${minutes} dakika × ${CALL_MINUTE_RATE_TRY} TL`],
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return false; // zaten ücretlendirilmiş
    }
    await client.query(`UPDATE users SET balance_try = balance_try + $2 WHERE id = $1`, [userId, amount]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface CreditTransactionRow {
  id: string;
  amount: number;
  type: string;
  vapiCallId: string | null;
  note: string | null;
  createdAt: string;
}

export async function listCreditTransactions(userId: string, limit = 50): Promise<CreditTransactionRow[]> {
  const { rows } = await pool.query(
    `SELECT id, amount, type, vapi_call_id, note, created_at
     FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(r => ({
    id: r.id, amount: Number(r.amount), type: r.type,
    vapiCallId: r.vapi_call_id, note: r.note, createdAt: r.created_at,
  }));
}

// ─── Fonzip (kredi kartıyla jeton yükleme) ─────────────────────────────────

export async function setFonzipUserId(userId: string, fonzipUserId: number): Promise<void> {
  await pool.query(`UPDATE users SET fonzip_user_id = $2 WHERE id = $1`, [userId, fonzipUserId]);
}

// Fonzip'te bir borç açıldığı anda çağrılır — bakiyeyi henüz ETKİLEMEZ (amount=0),
// sadece "bu debt_id bize ait, ödeme onayını bekliyoruz" diye işaretler. Webhook
// geldiğinde creditFonzipTopup bu satırı bulup gerçek tutarla günceller.
export async function createPendingFonzipTopup(userId: string, fonzipDebtId: string, requestedAmount: number): Promise<void> {
  await pool.query(
    `INSERT INTO credit_transactions (id, user_id, amount, type, fonzip_debt_id, note)
     VALUES ($1, $2, 0, 'card_topup', $3, $4)`,
    [newTxId(), userId, fonzipDebtId, `Bekliyor — ${requestedAmount} TL talep edildi`],
  );
}

// Fonzip webhook'u ödemeyi onayladığında çağrılır. WHERE amount = 0 koşulu iki şeyi
// aynı anda garanti eder: (1) bu debt_id bize ait DEĞİLSE (örn. alakasız gerçek bir
// aidat ödemesiyse) hiçbir satır bulunamaz → sessizce false döner, bakiyeye dokunmaz;
// (2) aynı webhook tekrar gelirse (Fonzip retry) satır artık amount=0 olmadığından
// tekrar eşleşmez → bakiye asla iki kez yüklenmez.
export async function creditFonzipTopup(fonzipDebtId: string, amountTry: number): Promise<{ credited: boolean; userId?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE credit_transactions SET amount = $2, note = $3
       WHERE fonzip_debt_id = $1 AND type = 'card_topup' AND amount = 0
       RETURNING user_id`,
      [fonzipDebtId, amountTry, `${amountTry} TL kart ile yüklendi (Fonzip)`],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return { credited: false };
    }
    const userId = updated.rows[0].user_id;
    await client.query(`UPDATE users SET balance_try = balance_try + $2 WHERE id = $1`, [userId, amountTry]);
    await client.query('COMMIT');
    return { credited: true, userId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Vapi credentials ───────────────────────────────────────────────────────

export async function setUserVapiCredentials(userId: string, patch: {
  apiKey?: string; publicKey?: string; phoneNumberId?: string; assistantId?: string; serverSecret?: string;
}): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  if (patch.apiKey !== undefined)        { vals.push(encryptSecret(patch.apiKey));       sets.push(`vapi_api_key_enc = $${vals.length}`); }
  if (patch.publicKey !== undefined)     { vals.push(patch.publicKey);                   sets.push(`vapi_public_key = $${vals.length}`); }
  if (patch.phoneNumberId !== undefined) { vals.push(patch.phoneNumberId);               sets.push(`vapi_phone_number_id = $${vals.length}`); }
  if (patch.assistantId !== undefined)   { vals.push(patch.assistantId);                 sets.push(`vapi_assistant_id = $${vals.length}`); }
  if (patch.serverSecret !== undefined)  { vals.push(encryptSecret(patch.serverSecret));  sets.push(`vapi_server_secret_enc = $${vals.length}`); }
  if (!sets.length) return;
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
}

export async function getUserVapiCredentials(userId: string): Promise<ResolvedVapiCredentials | null> {
  const { rows } = await pool.query(
    `SELECT vapi_api_key_enc, vapi_phone_number_id, vapi_assistant_id, vapi_server_secret_enc FROM users WHERE id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r || !r.vapi_api_key_enc || !r.vapi_phone_number_id || !r.vapi_assistant_id) return null;
  return {
    apiKey: decryptSecret(r.vapi_api_key_enc),
    phoneNumberId: r.vapi_phone_number_id,
    assistantId: r.vapi_assistant_id,
    serverSecret: r.vapi_server_secret_enc ? decryptSecret(r.vapi_server_secret_enc) : '',
  };
}

export async function resolveVapiCreds(userId: string): Promise<ResolvedVapiCredentials> {
  const creds = await getUserVapiCredentials(userId);
  if (!creds) throw new Error('Vapi hesap bilgileriniz tanımlı değil — Ayarlarım sayfasından ekleyin.');
  return creds;
}

// ─── ElevenLabs / Anthropic ─────────────────────────────────────────────────

export async function setUserElevenLabsKey(userId: string, apiKey: string): Promise<void> {
  await pool.query(`UPDATE users SET elevenlabs_api_key_enc = $2 WHERE id = $1`, [userId, encryptSecret(apiKey)]);
}

export async function getUserElevenLabsKey(userId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT elevenlabs_api_key_enc FROM users WHERE id = $1`, [userId]);
  const enc = rows[0]?.elevenlabs_api_key_enc;
  return enc ? decryptSecret(enc) : '';
}

export async function setUserAnthropicKey(userId: string, apiKey: string): Promise<void> {
  await pool.query(`UPDATE users SET anthropic_api_key_enc = $2 WHERE id = $1`, [userId, encryptSecret(apiKey)]);
}

export async function getUserAnthropicKey(userId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT anthropic_api_key_enc FROM users WHERE id = $1`, [userId]);
  const enc = rows[0]?.anthropic_api_key_enc;
  return enc ? decryptSecret(enc) : '';
}

// ─── "Ayarlarım" sayfası için maskeli görünüm ───────────────────────────────

function maskValue(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}

export interface UserSettingField {
  value: string;      // gizli anahtarlar maskeli, ID'ler açık
  masked: boolean;
  hasValue: boolean;
}

export interface UserSettingsView {
  vapiApiKey: UserSettingField;
  vapiPublicKey: UserSettingField;
  vapiPhoneNumberId: UserSettingField;
  vapiAssistantId: UserSettingField;
  elevenlabsApiKey: UserSettingField;
  anthropicApiKey: UserSettingField;
  companyName: UserSettingField;
}

export async function getSettingsForUser(userId: string): Promise<UserSettingsView> {
  const { rows } = await pool.query(
    `SELECT vapi_api_key_enc, vapi_public_key, vapi_phone_number_id, vapi_assistant_id,
            elevenlabs_api_key_enc, anthropic_api_key_enc, company_name
     FROM users WHERE id = $1`,
    [userId],
  );
  const r = rows[0] || {};
  const secretField = (enc: string | null): UserSettingField => {
    const raw = enc ? decryptSecret(enc) : '';
    return { value: raw ? maskValue(raw) : '', masked: true, hasValue: !!raw };
  };
  const plainField = (v: string | null): UserSettingField => ({
    value: v || '', masked: false, hasValue: !!v,
  });
  return {
    vapiApiKey: secretField(r.vapi_api_key_enc),
    vapiPublicKey: plainField(r.vapi_public_key),
    vapiPhoneNumberId: plainField(r.vapi_phone_number_id),
    vapiAssistantId: plainField(r.vapi_assistant_id),
    elevenlabsApiKey: secretField(r.elevenlabs_api_key_enc),
    anthropicApiKey: secretField(r.anthropic_api_key_enc),
    companyName: plainField(r.company_name),
  };
}

// ─── Bootstrap / migrasyon (server.ts açılışında bir kez çağrılır) ─────────

// İlk açılışta tek admin hesabı oluşturur ve varsa eski global app_settings
// key'lerini ona taşır (aynı şifreleme anahtarı kullanıldığı için API key
// ciphertext'leri çöz/tekrar-şifrele yapılmadan direkt kopyalanabilir —
// sadece phone_number_id/assistant_id düz metin sütunlar olduğu için çözülür).
export async function ensureBootstrapAdmin(hashPassword: (pw: string) => string): Promise<UserRow> {
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
  if (countRows[0].n > 0) {
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`,
    );
    if (rows[0]) return rowToUser(rows[0]);
  }

  const email    = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('İlk kurulum: BOOTSTRAP_ADMIN_EMAIL ve BOOTSTRAP_ADMIN_PASSWORD .env dosyasında tanımlı olmalı');
  }

  const admin = await createUser({ email, passwordHash: hashPassword(password), name: 'Admin', role: 'admin' });

  const { rows: settingsRows } = await pool.query(`SELECT key, value_enc FROM app_settings`);
  const legacyEnc = new Map<string, string>(settingsRows.map((r: any) => [r.key, r.value_enc]));

  // DB'de yoksa .env'e düş — getSetting()'in DB→.env fallback davranışıyla aynı
  // mantık, canlı pilotun (örn. sadece .env'de duran ANTHROPIC_API_KEY) kesintiye
  // uğramaması için.
  const resolvePlain = (key: string): string => {
    const enc = legacyEnc.get(key);
    return enc ? decryptSecret(enc) : (process.env[key] || '');
  };

  const sets: string[] = [];
  const vals: unknown[] = [admin.id];
  const copyEncryptedCol = (col: string, key: string) => {
    const plain = resolvePlain(key);
    if (plain) { vals.push(encryptSecret(plain)); sets.push(`${col} = $${vals.length}`); }
  };
  const copyPlainCol = (col: string, key: string) => {
    const plain = resolvePlain(key);
    if (plain) { vals.push(plain); sets.push(`${col} = $${vals.length}`); }
  };
  copyEncryptedCol('vapi_api_key_enc', 'VAPI_API_KEY');
  copyPlainCol('vapi_phone_number_id', 'VAPI_PHONE_NUMBER_ID');
  copyPlainCol('vapi_assistant_id', 'VAPI_ASSISTANT_ID');
  copyEncryptedCol('elevenlabs_api_key_enc', 'ELEVENLABS_API_KEY');
  copyEncryptedCol('anthropic_api_key_enc', 'ANTHROPIC_API_KEY');

  if (sets.length) {
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
  }

  console.log(`[Bootstrap] Admin hesabı oluşturuldu: ${email}${sets.length ? ' (eski global API key\'ler taşındı)' : ''}`);
  return (await getUserById(admin.id))!;
}

// Çok kiracılılık öncesi oluşmuş sahipsiz (user_id IS NULL) kayıtları bootstrap
// admin'e atar — idempotent (her boot'ta çalışır, ikinci çalıştırmada 0 satır döner).
export async function backfillOwnerlessRows(adminId: string): Promise<Record<string, number>> {
  const calls        = await pool.query(`UPDATE calls        SET user_id = $1 WHERE user_id IS NULL`, [adminId]);
  const appointments  = await pool.query(`UPDATE appointments SET user_id = $1 WHERE user_id IS NULL`, [adminId]);
  const scenarios     = await pool.query(`UPDATE scenarios    SET user_id = $1 WHERE user_id IS NULL`, [adminId]);
  const campaigns     = await pool.query(`UPDATE campaigns    SET user_id = $1 WHERE user_id IS NULL`, [adminId]);
  return {
    calls:        calls.rowCount ?? 0,
    appointments: appointments.rowCount ?? 0,
    scenarios:    scenarios.rowCount ?? 0,
    campaigns:    campaigns.rowCount ?? 0,
  };
}
