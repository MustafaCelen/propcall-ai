// PropCall AI — Fonzip entegrasyonu: danışmanların kredi kartıyla kendi jeton
// bakiyelerini yüklemesi için. Kart bilgisi hiçbir zaman bizim sunucumuza uğramaz —
// danışman, üzerinde bizim açtığımız bir "borç" (ödenmemiş aidat kaydı) bulunan
// Fonzip'in kendi hosted ödeme sayfasına yönlendirilir (bkz. generateTopupLink),
// ödeme tamamlanınca webhook ile haberdar oluruz (bkz. server.ts POST /webhook/fonzip).
//
// Fonzip'in client_credentials akışı aynı anda sadece TEK bir aktif token'a izin
// veriyor (ikinci istek 409 döner) — bu yüzden token süreç hafızası yerine DB'de
// tutulur, birden fazla deploy/instance arasında paylaşılabilsin.

import crypto from 'crypto';
import pool from './db';

const FONZIP_BASE = 'https://fonzip.com/api/v2';

interface TokenCache { token: string; expiresAt: number; }
let tokenCache: TokenCache | null = null;

async function loadTokenFromDB(): Promise<TokenCache | null> {
  try {
    const res = await pool.query(`SELECT value, expires_at FROM fonzip_config WHERE key = 'token'`);
    if (!res.rows.length) return null;
    return { token: res.rows[0].value, expiresAt: new Date(res.rows[0].expires_at).getTime() };
  } catch {
    return null;
  }
}

async function saveTokenToDB(token: string, expiresAt: number): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO fonzip_config (key, value, expires_at) VALUES ('token', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $1, expires_at = $2`,
      [token, new Date(expiresAt).toISOString()],
    );
  } catch (err) {
    console.error("[Fonzip] Token DB'ye kaydedilemedi:", err);
  }
}

async function createFreshToken(retryOn409 = true): Promise<string> {
  const clientId = process.env.FONZIP_CLIENT_ID;
  const clientSecret = process.env.FONZIP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('FONZIP_CLIENT_ID ve FONZIP_CLIENT_SECRET env değişkenleri tanımlı değil.');
  }

  const doCreate = () => fetch(`${FONZIP_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
  });

  let res = await doCreate();
  let attempt = 0;
  // 409: Fonzip'te aktif token var — 5 dk bekleyip tekrar dener (max 6 kez = 30 dk).
  while (res.status === 409 && retryOn409 && attempt < 6) {
    attempt++;
    console.log(`[Fonzip] 409 alındı, ${attempt}/6 — 5 dk bekleniyor...`);
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    res = await doCreate();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fonzip token alınamadı: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string };
  // Fonzip token ömrü 3600 sn — güvenli marjla 55 dk cache'liyoruz.
  const expiresAt = Date.now() + 55 * 60 * 1000;
  tokenCache = { token: data.access_token, expiresAt };
  await saveTokenToDB(data.access_token, expiresAt);
  return data.access_token;
}

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const dbToken = await loadTokenFromDB();
  if (dbToken && Date.now() < dbToken.expiresAt) { tokenCache = dbToken; return dbToken.token; }
  return createFreshToken();
}

async function callFonzip(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const doRequest = async (token: string) => fetch(`${FONZIP_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let token = await getToken();
  let res = await doRequest(token);

  if (res.status === 401) {
    tokenCache = null;
    token = await createFreshToken();
    res = await doRequest(token);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fonzip ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

export function isFonzipConfigured(): boolean {
  return !!(process.env.FONZIP_CLIENT_ID && process.env.FONZIP_CLIENT_SECRET);
}

// Danışmanın e-postasına göre Fonzip'teki karşılığını arar — şirket zaten aidat
// sistemi için Fonzip kullandığından danışmanlar çoğunlukla oradan zaten kayıtlı.
export async function findFonzipUserByEmail(email: string): Promise<number | null> {
  const data = await callFonzip('POST', '/users', {
    search: {
      start_page: 1, how_many: 1, order_by: 'id',
      filter: { condition: 'and', attributes: [{ type: 'default', parameter: 'email', condition: 'eq', value: email }] },
    },
    values_list: ['id'],
  });
  return data.user_list?.[0]?.id ?? null;
}

// Eşleşme bulunamazsa yeni bir Fonzip üyesi oluşturur.
async function createFonzipUser(name: string, email: string): Promise<number> {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] || name || 'Danışman';
  const lastName = parts.slice(1).join(' ') || '-';
  const data = await callFonzip('POST', '/user', { first_name: firstName, last_name: lastName, email });
  return data.user_id;
}

// Danışmanın Fonzip user id'sini bulur/oluşturur — sonucu users.fonzip_user_id'ye
// kalıcı yazar, bir daha aramaya gerek kalmasın.
export async function resolveFonzipUserId(userId: string, name: string, email: string): Promise<number> {
  const { getUserById, setFonzipUserId } = await import('./users');
  const user = await getUserById(userId);
  if (user?.fonzipUserId) return user.fonzipUserId;

  let fonzipUserId = await findFonzipUserByEmail(email);
  if (!fonzipUserId) fonzipUserId = await createFonzipUser(name, email);

  await setFonzipUserId(userId, fonzipUserId);
  return fonzipUserId;
}

// Ödenmemiş bir borç açar — dönen debt_id idempotency key olarak kullanılır
// (bkz. users.ts createPendingFonzipTopup/creditFonzipTopup).
export async function createTopupDebt(fonzipUserId: number, amountTry: number, details: string): Promise<number> {
  const data = await callFonzip('POST', '/debt', { user_id: fonzipUserId, details, amount: amountTry });
  if (!data.debt_id) throw new Error('Fonzip borç oluşturuldu ama debt_id dönmedi');
  return data.debt_id;
}

// Danışmanı Fonzip'in kendi (hosted) borç ödeme sayfasına yönlendirecek tek
// kullanımlık link — redirection_type=3 "Dues payment page of user".
export async function generateTopupLink(fonzipUserId: number): Promise<string> {
  const data = await callFonzip('GET', `/user/${fonzipUserId}/login-link?redirection_type=3`);
  if (!data.link) throw new Error('Fonzip login-link üretilemedi');
  return data.link;
}

export interface FonzipDebtStatus {
  amount: number;
  // 1: ödenmemiş, 6: kaldırılmış/pasif, 8: ödenmiş
  status: number;
}

export async function getDebtDetails(debtId: number | string): Promise<FonzipDebtStatus | null> {
  const data = await callFonzip('GET', `/debt/${debtId}`);
  const s = data.subscription;
  if (!s || s.amount == null) return null;
  return { amount: Number(s.amount), status: Number(s.status) };
}

export async function getDebtAmount(debtId: number | string): Promise<number | null> {
  const details = await getDebtDetails(debtId);
  return details?.amount ?? null;
}

// Ödenmemiş, artık gereksiz kalmış bir borcu siler — sadece hâlâ ödenmemiş (status 1)
// borçlar için çağrılmalı, ödenmiş bir borcu asla silme (bkz. cleanupStalePendingTopups).
export async function cancelDebt(debtId: number | string): Promise<void> {
  await callFonzip('DELETE', `/debt/${debtId}`);
}

// Webhook'un X-FZ-Auth-Token header'ını doğrulamak için kullanılan gizli değer —
// ilk çağrıda üretilip DB'ye yazılır, sonraki her çağrıda aynısı döner.
export async function getOrCreateWebhookAuthToken(): Promise<string> {
  const { rows } = await pool.query(`SELECT value FROM fonzip_config WHERE key = 'webhook_auth_token'`);
  if (rows[0]?.value) return rows[0].value;
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO fonzip_config (key, value) VALUES ('webhook_auth_token', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [token],
  );
  return token;
}

export async function verifyWebhookAuthToken(headerToken: string | undefined): Promise<boolean> {
  if (!headerToken) return false;
  const expected = await getOrCreateWebhookAuthToken();
  return headerToken === expected;
}

// Ödeme tamamlandığında bize bildirim gelmesi için webhook kaydeder — aynı URL
// zaten kayıtlıysa tekrar oluşturmaz (boot'ta her seferinde çağrılabilir).
export async function ensureWebhookRegistered(callbackUrl: string): Promise<void> {
  const authToken = await getOrCreateWebhookAuthToken();
  const existing = await callFonzip('GET', '/webhooks');
  const already = (existing.webhook_list || []).some((w: any) => w.url === callbackUrl);
  if (already) return;

  // Fonzip webhook adlarının hesap genelinde benzersiz olmasını istiyor — staging ve
  // production aynı Fonzip hesabını paylaştığından (aynı client_id/secret) adı ortama
  // göre farklılaştırıyoruz. NOT: isimde parantez kullanmayın — Fonzip API'si bu durumda
  // 500 döndürüyor (doğrulandı), düz alfanümerik + tire güvenli.
  const env = callbackUrl.includes('staging') ? 'Staging' : 'Production';
  await callFonzip('POST', '/webhooks', {
    name: `PropCall Jeton Yukleme - ${env}`,
    url: callbackUrl,
    authentication: true,
    auth_token: authToken,
    // Fonzip sadece istenen event'i (SUBSCRIPTION) gönderip diğerlerini boş bırakınca
    // 500 veriyor — tüm alanları açıkça false/true belirtmek gerekiyor.
    events: {
      DONATION: false, SUBSCRIPTION: true, TICKET: false,
      FORM: false, CERTIFICATE_SALE: false, FUNDRAISING_CAMPAIGN: false,
    },
  });
  console.log(`[Fonzip] Webhook kaydedildi → ${callbackUrl}`);
}

// Danışman "+ Yükle" deyip ödemeyi tamamlamadan vazgeçerse (sekmeyi kapatırsa), aynı
// tutar için tekrar tekrar borç açılmasın diye — son 1 saat içinde açılmış, hâlâ
// bekleyen (henüz kredilenmemiş) bir talebi varsa onu döner, yeni borç açmaz.
export async function findPendingTopup(userId: string): Promise<{ fonzipDebtId: string } | null> {
  const { rows } = await pool.query(
    `SELECT fonzip_debt_id FROM credit_transactions
     WHERE user_id = $1 AND type = 'card_topup' AND amount = 0
       AND created_at > NOW() - INTERVAL '1 hour'
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ? { fonzipDebtId: rows[0].fonzip_debt_id } : null;
}

// 1 saatten eski, hâlâ "bekleyen" (amount=0) kart yükleme taleplerini tarar. Fonzip'te
// borç GERÇEKTE ödenmiş ama webhook bir sebeple gelmemişse (kaçırılmış webhook) bakiyeyi
// burada kendiliğinden düzeltir; hâlâ ödenmemişse gerçekten terk edilmiş demektir —
// borcu Fonzip'ten siler (danışmanın Fonzip kaydında kalıcı "hayalet borç" kalmasın)
// ve bizim bekleyen kaydımızı temizler.
export async function cleanupStalePendingTopups(): Promise<{ healedUserIds: string[]; cancelled: number; errors: number }> {
  const { rows } = await pool.query(
    `SELECT id, fonzip_debt_id, user_id FROM credit_transactions
     WHERE type = 'card_topup' AND amount = 0 AND created_at < NOW() - INTERVAL '1 hour'`,
  );
  if (!rows.length) return { healedUserIds: [], cancelled: 0, errors: 0 };

  const { creditFonzipTopup } = await import('./users');
  const healedUserIds: string[] = [];
  let cancelled = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const details = await getDebtDetails(row.fonzip_debt_id);
      if (!details || details.status !== 8) {
        // Hâlâ ödenmemiş (ya da Fonzip'te artık bulunamıyor) — gerçekten terk edilmiş.
        if (details) await cancelDebt(row.fonzip_debt_id);
        await pool.query(`DELETE FROM credit_transactions WHERE id = $1`, [row.id]);
        cancelled++;
        continue;
      }
      // status === 8: ödenmiş ama webhook kaçırılmış — bakiyeyi şimdi düzelt.
      const result = await creditFonzipTopup(row.fonzip_debt_id, details.amount);
      if (result.credited && result.userId) healedUserIds.push(result.userId);
    } catch (err) {
      console.error(`[Fonzip] Bekleyen yükleme temizliği hatası (debtId=${row.fonzip_debt_id}):`, err);
      errors++;
    }
  }

  if (healedUserIds.length || cancelled) {
    console.log(`[Fonzip] Bekleyen yükleme temizliği: ${healedUserIds.length} düzeltildi (kaçırılmış webhook), ${cancelled} iptal edildi (ödenmemiş, 1 saat doldu)`);
  }
  return { healedUserIds, cancelled, errors };
}
