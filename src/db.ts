import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|@db:/.test(process.env.DATABASE_URL ?? '')
    ? false
    : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis:     30_000,
  connectionTimeoutMillis: 10_000,
});

// Neon serverless: uç nokta askıya alındığında pool 'error' fırlatır.
// İşlenmezse Node süreci çöker — bu hatayı yakala ve yoksay (bağlantı zaten yeniden denenir).
pool.on('error', (err) => {
  console.warn('[DB] Pool bağlantı hatası (yeniden denenecek):', (err as Error).message);
});

const INIT_RETRIES    = 8;
const INIT_RETRY_MS   = 2_000; // Neon uç noktası genellikle 1-3 sn içinde uyanır

export async function initDb(): Promise<void> {
  const ddl = `
    -- Danışman (consultant) hesapları — çok kiracılı (multi-tenant) mimarinin temeli.
    -- password_hash formatı: "N:r:p:saltHex:hashHex" (scrypt, bkz. src/auth.ts).
    CREATE TABLE IF NOT EXISTS users (
      id                     TEXT PRIMARY KEY,
      email                  TEXT UNIQUE NOT NULL,
      password_hash          TEXT NOT NULL,
      name                   TEXT,
      role                   TEXT NOT NULL DEFAULT 'agent', -- 'agent' | 'admin'
      is_active              BOOLEAN NOT NULL DEFAULT true,
      vapi_api_key_enc       TEXT,
      vapi_public_key        TEXT,  -- tarayıcıdan sesli test için — private key'den farklı, açığa çıkması güvenli
      vapi_phone_number_id   TEXT,
      vapi_assistant_id      TEXT,
      vapi_server_secret_enc TEXT,
      elevenlabs_api_key_enc TEXT,
      anthropic_api_key_enc  TEXT,
      max_concurrent_calls   INT NOT NULL DEFAULT 3,
      calling_hours_start    INT,  -- 0-23, NULL = sınır yok
      calling_hours_end      INT,  -- 0-23, NULL = sınır yok
      elevenlabs_cost_per_1k NUMERIC,  -- $/1000 karakter, NULL = kullanıcı henüz girmedi
      balance_try            NUMERIC NOT NULL DEFAULT 0,  -- jeton bakiyesi (TL) — 1 jeton = 1 TL
      last_login_at          TIMESTAMPTZ,
      created_at             TIMESTAMPTZ DEFAULT NOW()
    );

    -- users tablosu zaten var olan kurulumlarda yukarıdaki CREATE bir no-op olur —
    -- yeni sütunları var olan tabloya eklemek için ayrıca gerekli.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS calling_hours_start INT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS calling_hours_end   INT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS elevenlabs_cost_per_1k NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vapi_public_key TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_try NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS fonzip_user_id INT;  -- Fonzip'teki karşılık gelen üye id'si (kart ile jeton yükleme için)

    -- Jeton (TL) hareketleri — her yükleme/ücretlendirme kalıcı bir satır. balance_try
    -- hızlı okunabilir güncel bakiye, buradaki kayıtlar denetim/geçmiş içindir.
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id),
      amount         NUMERIC NOT NULL,   -- pozitif: yükleme/düzeltme, negatif: arama ücreti
      type           TEXT NOT NULL,      -- 'topup' | 'call_charge' | 'adjustment' | 'card_topup'
      vapi_call_id   TEXT,               -- call_charge işlemleri için
      fonzip_debt_id TEXT,               -- card_topup işlemleri için (Fonzip borç id'si)
      note           TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id);
    ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS fonzip_debt_id TEXT;
    -- Aynı aramayı iki kez ücretlendirmeyi DB seviyesinde imkansız kılar — bir webhook
    -- (örn. deploy sırasında) tekrar gönderilse bile ikinci ücretlendirme sessizce reddedilir.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_call_charge
      ON credit_transactions(vapi_call_id) WHERE type = 'call_charge';
    -- Aynı Fonzip ödemesi (webhook tekrar gönderilse bile) bakiyeye iki kez işlenemez.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_fonzip_debt
      ON credit_transactions(fonzip_debt_id) WHERE type = 'card_topup';

    -- Fonzip OAuth token'ı hesaplar arası paylaşılır ve tekrar-kullanılmalıdır (aynı anda
    -- ikinci bir token isteği 409 döner) — bu yüzden süreç hafızası yerine DB'de tutulur.
    CREATE TABLE IF NOT EXISTS fonzip_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      expires_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS calls (
      vapi_call_id TEXT PRIMARY KEY,
      data         JSONB NOT NULL,
      start_time   TIMESTAMPTZ,
      status       TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaign_state (
      id         TEXT PRIMARY KEY DEFAULT 'current',
      data       JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Kalıcı kampanya kayıtları — geçmiş kampanyalar karşılaştırılabilir, silinmez.
    -- campaign_state (yukarıdaki) artık kullanılmıyor, geriye dönük uyumluluk için duruyor.
    CREATE TABLE IF NOT EXISTS campaigns (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      scenario_id      TEXT,
      scenario_name    TEXT,
      status           TEXT NOT NULL DEFAULT 'draft', -- draft|running|paused|completed|stopped
      max_concurrent   INT  NOT NULL DEFAULT 1,
      start_from_index INT  NOT NULL DEFAULT 0,
      call_limit       INT  NOT NULL DEFAULT 0,
      answered_limit   INT  NOT NULL DEFAULT 0,
      contacts         JSONB NOT NULL DEFAULT '[]',
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      started_at       TIMESTAMPTZ,
      completed_at     TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_status     ON campaigns (status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_campaign_id    ON calls ((data ->> 'campaignId'));

    -- Çok kiracılı veri izolasyonu — nullable (eski kayıtlar boot sırasında admin'e atanır, bkz. src/users.ts backfillOwnerlessRows).
    ALTER TABLE calls        ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
    ALTER TABLE scenarios    ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
    ALTER TABLE campaigns    ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_calls_user_id        ON calls (user_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_user_id ON appointments (user_id);
    CREATE INDEX IF NOT EXISTS idx_scenarios_user_id    ON scenarios (user_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_user_id    ON campaigns (user_id);

    -- Admin panelden girilen API key'leri (şifreli) — .env yerine canlı override
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value_enc  TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Admin panel için basit şifre-korumalı oturum
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id         TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_calls_start_time      ON calls (start_time DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_calls_status          ON calls (status);
    CREATE INDEX IF NOT EXISTS idx_calls_customer_phone  ON calls ((data ->> 'customerPhone'));
    CREATE INDEX IF NOT EXISTS idx_calls_scenario_id     ON calls ((data ->> 'scenarioId'));
    CREATE INDEX IF NOT EXISTS idx_calls_follow_up       ON calls (((data ->> 'followUp')::boolean))
      WHERE (data ->> 'followUp')::boolean = true;
  `;

  for (let attempt = 1; attempt <= INIT_RETRIES; attempt++) {
    try {
      await pool.query(ddl);
      return;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const isWaking =
        msg.includes('endpoint has been disabled') ||
        msg.includes('connection refused') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('terminating connection');

      if (isWaking && attempt < INIT_RETRIES) {
        console.warn(`[DB] Bağlantı denemesi ${attempt}/${INIT_RETRIES} başarısız — ${INIT_RETRY_MS / 1000}sn sonra yeniden denenecek:`, msg);
        await new Promise(r => setTimeout(r, INIT_RETRY_MS));
      } else {
        throw err;
      }
    }
  }
}

export default pool;
