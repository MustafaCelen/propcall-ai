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
