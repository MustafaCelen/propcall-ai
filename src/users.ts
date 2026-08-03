// Kullanıcı CRUD + secret erişim helper'ları

import crypto from 'crypto';
import pool from './db';
import { encryptSecret, decryptSecret } from './crypto';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  google_id: string | null;
  picture_url: string | null;
  role: 'agent' | 'admin';
  is_active: boolean;
  vapi_phone_number_id: string | null;
  vapi_assistant_id: string | null;
  elevenlabs_voice_id: string | null;
  onboarding_completed: boolean;
  last_login_at: string | null;
  created_at: string;
}

function newUserId(): string {
  return 'usr_' + crypto.randomBytes(9).toString('base64url');
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query(
    `SELECT id, email, name, google_id, picture_url, role, is_active,
            vapi_phone_number_id, vapi_assistant_id, elevenlabs_voice_id,
            onboarding_completed, last_login_at, created_at
       FROM users WHERE id = $1`, [id],
  );
  return rows[0] || null;
}

export async function getUserByGoogleId(googleId: string): Promise<UserRow | null> {
  const { rows } = await pool.query(
    `SELECT id, email, name, google_id, picture_url, role, is_active,
            vapi_phone_number_id, vapi_assistant_id, elevenlabs_voice_id,
            onboarding_completed, last_login_at, created_at
       FROM users WHERE google_id = $1`, [googleId],
  );
  return rows[0] || null;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query(
    `SELECT id, email, name, google_id, picture_url, role, is_active,
            vapi_phone_number_id, vapi_assistant_id, elevenlabs_voice_id,
            onboarding_completed, last_login_at, created_at
       FROM users WHERE email = $1`, [email.toLowerCase()],
  );
  return rows[0] || null;
}

export async function upsertGoogleUser(profile: {
  googleId: string;
  email: string;
  name?: string;
  pictureUrl?: string;
}): Promise<UserRow> {
  // Önce google_id'ye göre bak (kullanıcı zaten var mı)
  let existing = await getUserByGoogleId(profile.googleId);
  if (!existing) {
    // Sonra email'e göre bak — belki manuel eklenmiş bir user var, google_id'yi ilk giriş bağla
    existing = await getUserByEmail(profile.email);
  }

  if (existing) {
    await pool.query(
      `UPDATE users SET google_id = $1, name = COALESCE($2, name), picture_url = COALESCE($3, picture_url),
              last_login_at = NOW() WHERE id = $4`,
      [profile.googleId, profile.name || null, profile.pictureUrl || null, existing.id],
    );
    return (await getUserById(existing.id))!;
  }

  const id = newUserId();
  await pool.query(
    `INSERT INTO users (id, email, name, google_id, picture_url, role, is_active, last_login_at)
     VALUES ($1, $2, $3, $4, $5, 'agent', true, NOW())`,
    [id, profile.email.toLowerCase(), profile.name || null, profile.googleId, profile.pictureUrl || null],
  );
  return (await getUserById(id))!;
}

// ─── Vapi credential yönetimi ──────────────────────────────────────────────

export async function setUserVapiCredentials(userId: string, params: {
  apiKey?: string;
  phoneNumberId?: string | null;
  assistantId?: string | null;
}): Promise<void> {
  const parts: string[] = [];
  const vals: any[]     = [];
  let idx = 1;
  if (params.apiKey !== undefined) {
    parts.push(`vapi_api_key_enc = $${idx++}`);
    vals.push(params.apiKey ? encryptSecret(params.apiKey) : null);
  }
  if (params.phoneNumberId !== undefined) {
    parts.push(`vapi_phone_number_id = $${idx++}`);
    vals.push(params.phoneNumberId);
  }
  if (params.assistantId !== undefined) {
    parts.push(`vapi_assistant_id = $${idx++}`);
    vals.push(params.assistantId);
  }
  if (!parts.length) return;
  vals.push(userId);
  await pool.query(`UPDATE users SET ${parts.join(', ')} WHERE id = $${idx}`, vals);
}

export async function getUserVapiApiKey(userId: string): Promise<string | null> {
  const { rows } = await pool.query(
    'SELECT vapi_api_key_enc FROM users WHERE id = $1', [userId],
  );
  const enc = rows[0]?.vapi_api_key_enc;
  return enc ? decryptSecret(enc) : null;
}

export async function setUserElevenLabsCredentials(userId: string, params: {
  apiKey?: string;
  voiceId?: string | null;
}): Promise<void> {
  const parts: string[] = [];
  const vals: any[]     = [];
  let idx = 1;
  if (params.apiKey !== undefined) {
    parts.push(`elevenlabs_api_key_enc = $${idx++}`);
    vals.push(params.apiKey ? encryptSecret(params.apiKey) : null);
  }
  if (params.voiceId !== undefined) {
    parts.push(`elevenlabs_voice_id = $${idx++}`);
    vals.push(params.voiceId);
  }
  if (!parts.length) return;
  vals.push(userId);
  await pool.query(`UPDATE users SET ${parts.join(', ')} WHERE id = $${idx}`, vals);
}

export async function getUserElevenLabsApiKey(userId: string): Promise<string | null> {
  const { rows } = await pool.query(
    'SELECT elevenlabs_api_key_enc FROM users WHERE id = $1', [userId],
  );
  const enc = rows[0]?.elevenlabs_api_key_enc;
  return enc ? decryptSecret(enc) : null;
}

export async function markOnboardingComplete(userId: string): Promise<void> {
  await pool.query('UPDATE users SET onboarding_completed = true WHERE id = $1', [userId]);
}

// ─── Admin helpers ─────────────────────────────────────────────────────────

export async function listUsers(): Promise<UserRow[]> {
  const { rows } = await pool.query(
    `SELECT id, email, name, google_id, picture_url, role, is_active,
            vapi_phone_number_id, vapi_assistant_id, elevenlabs_voice_id,
            onboarding_completed, last_login_at, created_at
       FROM users ORDER BY created_at DESC`,
  );
  return rows;
}

export async function setUserActive(userId: string, active: boolean): Promise<void> {
  await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [active, userId]);
}

export async function setUserRole(userId: string, role: 'agent' | 'admin'): Promise<void> {
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
}
