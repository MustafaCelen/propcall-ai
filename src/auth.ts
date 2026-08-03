// Google OAuth + session yönetimi

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import pool from './db';
import { getUserById, upsertGoogleUser, UserRow } from './users';

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const APP_URL              = process.env.APP_URL || 'http://localhost:3000';
const SESSION_TTL_DAYS     = 30;
const COOKIE_NAME          = 'propcall_sid';

// Kayıt izni: sadece bu domainlerdeki hesaplar kabul edilir. Boşsa herkes.
// Örn: "kw.com.tr,karma.com.tr"
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || '')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

function getOAuthClient(): OAuth2Client {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID/SECRET tanımlı değil');
  }
  return new OAuth2Client({
    clientId:     GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri:  `${APP_URL}/auth/google/callback`,
  });
}

function newSessionId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

async function createSession(userId: string): Promise<string> {
  const sid = newSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
  await pool.query(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sid, userId, expires],
  );
  return sid;
}

async function readSession(sid: string): Promise<string | null> {
  if (!sid) return null;
  const { rows } = await pool.query(
    'SELECT user_id, expires_at FROM sessions WHERE id = $1',
    [sid],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [sid]);
    return null;
  }
  return row.user_id;
}

async function destroySession(sid: string): Promise<void> {
  if (sid) await pool.query('DELETE FROM sessions WHERE id = $1', [sid]);
}

function setSessionCookie(res: Response, sid: string): void {
  const secure = APP_URL.startsWith('https://');
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86400 * 1000,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function emailAllowed(email: string): boolean {
  if (!ALLOWED_DOMAINS.length) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && ALLOWED_DOMAINS.includes(domain);
}

// ─── Express integration ───────────────────────────────────────────────────

// Extended Request type
declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
    user?: UserRow;
  }
}

// Redirect kullanıcıyı Google'a
export function handleGoogleLogin(req: Request, res: Response): void {
  try {
    const client = getOAuthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: ['openid', 'email', 'profile'],
      prompt: 'select_account',
    });
    res.redirect(url);
  } catch (err) {
    res.status(500).send('Google OAuth yapılandırılmamış: ' + String(err));
  }
}

// Google callback — token exchange + session
export async function handleGoogleCallback(req: Request, res: Response): Promise<void> {
  try {
    const code = String(req.query.code || '');
    if (!code) { res.redirect('/login?error=no_code'); return; }

    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) { res.redirect('/login?error=no_token'); return; }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) { res.redirect('/login?error=no_payload'); return; }

    if (!emailAllowed(payload.email)) {
      res.redirect('/login?error=domain_not_allowed');
      return;
    }

    const user = await upsertGoogleUser({
      googleId:   payload.sub,
      email:      payload.email,
      name:       payload.name,
      pictureUrl: payload.picture,
    });

    if (!user.is_active) { res.redirect('/login?error=deactivated'); return; }

    const sid = await createSession(user.id);
    setSessionCookie(res, sid);

    res.redirect(user.onboarding_completed ? '/' : '/onboarding');
  } catch (err) {
    console.error('[Auth] Google callback hatası:', err);
    res.redirect('/login?error=callback_failed');
  }
}

export async function handleLogout(req: Request, res: Response): Promise<void> {
  const sid = req.cookies?.[COOKIE_NAME];
  await destroySession(sid);
  clearSessionCookie(res);
  res.redirect('/login');
}

// Auth middleware — SPA/API için
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = req.cookies?.[COOKIE_NAME];
  const userId = await readSession(sid);
  if (!userId) {
    // API request için 401, sayfa request için redirect
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      res.status(401).json({ success: false, error: 'not_authenticated' });
    } else {
      res.redirect('/login');
    }
    return;
  }
  const user = await getUserById(userId);
  if (!user || !user.is_active) {
    clearSessionCookie(res);
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ success: false, error: 'session_invalid' });
    } else {
      res.redirect('/login');
    }
    return;
  }
  req.userId = user.id;
  req.user   = user;
  next();
}

// Admin-only guard
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, error: 'admin_only' });
    return;
  }
  next();
}

// Optional auth — attaches user if logged in, doesn't block
export async function attachUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = req.cookies?.[COOKIE_NAME];
  const userId = await readSession(sid);
  if (userId) {
    const user = await getUserById(userId);
    if (user && user.is_active) {
      req.userId = user.id;
      req.user   = user;
    }
  }
  next();
}
