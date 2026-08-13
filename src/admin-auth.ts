// Admin panel için basit şifre-korumalı oturum yönetimi.
// Tek kullanıcılı (operatör) bir panel olduğu için tam auth sistemi yerine
// paylaşılan şifre + session cookie yeterli.

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import pool from './db';

const COOKIE_NAME     = 'propcall_admin_sid';
const SESSION_TTL_MS  = 12 * 60 * 60 * 1000; // 12 saat

function newSessionId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export async function adminLogin(req: Request, res: Response): Promise<void> {
  const { password } = req.body as { password?: string };
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    res.status(500).json({ success: false, error: 'ADMIN_PASSWORD tanımlanmamış (.env dosyasına ekleyin)' });
    return;
  }
  if (!password || password !== expected) {
    res.status(401).json({ success: false, error: 'Yanlış şifre' });
    return;
  }

  const sid       = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO admin_sessions (id, expires_at) VALUES ($1, $2)', [sid, expiresAt]);

  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  res.json({ success: true });
}

export async function adminLogout(req: Request, res: Response): Promise<void> {
  const sid = req.cookies?.[COOKIE_NAME];
  if (sid) await pool.query('DELETE FROM admin_sessions WHERE id = $1', [sid]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ success: true });
}

export async function requireAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = req.cookies?.[COOKIE_NAME];
  if (!sid) {
    res.status(401).json({ success: false, error: 'not_authenticated' });
    return;
  }
  const { rows } = await pool.query('SELECT expires_at FROM admin_sessions WHERE id = $1', [sid]);
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(401).json({ success: false, error: 'session_expired' });
    return;
  }
  next();
}
