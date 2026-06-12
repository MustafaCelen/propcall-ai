import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function initDb(): Promise<void> {
  await pool.query(`
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

    CREATE INDEX IF NOT EXISTS idx_calls_start_time      ON calls (start_time DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_calls_status          ON calls (status);
    CREATE INDEX IF NOT EXISTS idx_calls_customer_phone  ON calls ((data ->> 'customerPhone'));
    CREATE INDEX IF NOT EXISTS idx_calls_scenario_id     ON calls ((data ->> 'scenarioId'));
    CREATE INDEX IF NOT EXISTS idx_calls_follow_up       ON calls (((data ->> 'followUp')::boolean)) WHERE (data ->> 'followUp')::boolean = true;
  `);
}

export default pool;
