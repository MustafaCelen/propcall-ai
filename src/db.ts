import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
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
    -- ─── Kullanıcı & Auth ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      email           TEXT UNIQUE NOT NULL,
      name            TEXT,
      google_id       TEXT UNIQUE,
      picture_url     TEXT,
      role            TEXT NOT NULL DEFAULT 'agent',  -- 'agent' | 'admin'
      is_active       BOOLEAN NOT NULL DEFAULT true,
      -- Vapi (kişisel, şifreli)
      vapi_api_key_enc      TEXT,
      vapi_phone_number_id  TEXT,
      vapi_assistant_id     TEXT,
      -- ElevenLabs (opsiyonel, şifreli)
      elevenlabs_api_key_enc TEXT,
      elevenlabs_voice_id    TEXT,
      -- Onboarding
      onboarding_completed BOOLEAN NOT NULL DEFAULT false,
      last_login_at        TIMESTAMPTZ,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id);
    CREATE INDEX IF NOT EXISTS idx_users_email     ON users (email);

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

    CREATE TABLE IF NOT EXISTS calls (
      vapi_call_id TEXT PRIMARY KEY,
      user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
      data         JSONB NOT NULL,
      start_time   TIMESTAMPTZ,
      status       TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id         TEXT PRIMARY KEY,
      user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id         TEXT PRIMARY KEY,
      user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Kişi başı 1 aktif kampanya — primary key user_id
    CREATE TABLE IF NOT EXISTS campaign_state (
      user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_calls_user_id         ON calls (user_id);
    CREATE INDEX IF NOT EXISTS idx_calls_start_time      ON calls (start_time DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_calls_status          ON calls (status);
    CREATE INDEX IF NOT EXISTS idx_calls_customer_phone  ON calls ((data ->> 'customerPhone'));
    CREATE INDEX IF NOT EXISTS idx_calls_scenario_id     ON calls ((data ->> 'scenarioId'));
    CREATE INDEX IF NOT EXISTS idx_calls_follow_up       ON calls (((data ->> 'followUp')::boolean))
      WHERE (data ->> 'followUp')::boolean = true;
    CREATE INDEX IF NOT EXISTS idx_appointments_user_id  ON appointments (user_id);
    CREATE INDEX IF NOT EXISTS idx_scenarios_user_id     ON scenarios (user_id);
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
