// PropCall AI — Danışman (consultant) e-posta + şifre auth: scrypt hash + session cookie.
// src/admin-auth.ts'teki (paylaşımlı tek şifre) mantığın kişi-bazlı hesaplara genişletilmiş hali.

import crypto from 'crypto';
import { promisify } from 'util';
import { Request, Response, NextFunction } from 'express';
import pool from './db';
import { getAuthRecord, getUserById, touchLastLogin, recordTermsAcceptance, UserRow } from './users';

const COOKIE_NAME    = 'propcall_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

// Kullanım Koşulları ve Sorumluluk Beyanı'nın mevcut versiyonu (bkz. public/terms.js
// TERMS_TEXT ile birebir aynı içeriği temsil eder — metin ANLAMLI şekilde değişirse
// burası artırılır, bu da terms_accepted_version'ı geçersiz kılıp danışmanı tekrar
// onaya zorlar). Sadece yazım/kozmetik düzeltmeler için artırmaya gerek yok.
export const CURRENT_TERMS_VERSION = 1;

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

// Async scrypt — scryptSync event loop'u ~50-100ms kilitliyordu; eşzamanlı birkaç
// giriş denemesi tüm webhook/SSE trafiğini duraklatıyordu. Parametre ve kodlama
// aynı kaldı, mevcut hash'ler aynen doğrulanmaya devam eder.
const scryptAsync = promisify(crypto.scrypt) as (
  password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions,
) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 5) return false;
  const [nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt     = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual   = await scryptAsync(password, salt, expected.length, {
    N: Number(nStr), r: Number(rStr), p: Number(pStr),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function newSessionId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
    user?: UserRow;
  }
}

// Oturum çerezinin adı/okunması — server.ts'in şifre değişikliğinde "mevcut oturum
// hariç tüm oturumları kapat" yapabilmesi için dışa açık.
export function getSessionIdFromRequest(req: Request): string | undefined {
  const sid = req.cookies?.[COOKIE_NAME];
  return typeof sid === 'string' && sid ? sid : undefined;
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string' || password.length > 256) {
      res.status(400).json({ success: false, error: 'Geçersiz istek' });
      return;
    }
    if (!email || !password) {
      res.status(400).json({ success: false, error: 'E-posta ve şifre zorunlu' });
      return;
    }

    const record = await getAuthRecord(email);
    if (!record || !(await verifyPassword(password, record.passwordHash))) {
      res.status(401).json({ success: false, error: 'E-posta veya şifre hatalı' });
      return;
    }
    if (!record.isActive) {
      res.status(403).json({ success: false, error: 'Hesabınız devre dışı bırakılmış — yöneticinizle iletişime geçin' });
      return;
    }

    const sid       = newSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query('INSERT INTO user_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [sid, record.id, expiresAt]);
    await touchLastLogin(record.id);

    res.cookie(COOKIE_NAME, sid, {
      httpOnly: true,
      sameSite: 'lax',
      // Production (Railway) her zaman HTTPS — oturum çerezinin düz HTTP üzerinden
      // gönderilmesine izin vermeye gerek yok. Yerel geliştirme http://localhost
      // üzerinden çalıştığı için orada kapalı bırakılır, aksi halde hiç giriş yapılamaz.
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });

    res.json({ success: true, data: await getUserById(record.id) });
  } catch (err) {
    console.error('[Auth] Giriş hatası:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Sunucu hatası' });
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (sid) await pool.query('DELETE FROM user_sessions WHERE id = $1', [sid]);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Çıkış hatası:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Sunucu hatası' });
  }
}

async function resolveSession(req: Request): Promise<UserRow | null> {
  const sid = req.cookies?.[COOKIE_NAME];
  if (!sid) return null;

  const { rows } = await pool.query('SELECT user_id, expires_at FROM user_sessions WHERE id = $1', [sid]);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM user_sessions WHERE id = $1', [sid]);
    return null;
  }

  const user = await getUserById(row.user_id);
  if (!user || !user.isActive) return null;
  return user;
}

// Terms'i henüz kabul etmemiş bir danışmanın YİNE DE çağırabilmesi gereken uçlar —
// oturum bilgisini okumak, kabul etmek, çıkış yapmak. Bu kısa liste dışındaki HER
// /api/* uç (arama başlatma, mesaj gönderme, aday/kampanya işlemleri...) 403 alır —
// sadece frontend modalına güvenmek yeterli değil, sunucu tarafında da kilitli olmalı.
const TERMS_EXEMPT_PATHS = new Set(['/api/auth/session', '/api/terms/accept', '/api/auth/logout']);

// Oturum çözümlemesi (DB) patlarsa Express 4 async hatayı yakalamaz — istek askıda
// kalır ve unhandled rejection olur. Burada 500 JSON ile kapatılır.
function sessionError(res: Response, err: unknown): void {
  console.error('[Auth] Oturum doğrulama hatası:', err);
  if (!res.headersSent) res.status(500).json({ success: false, error: 'Sunucu hatası' });
}

export async function requireUserAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await resolveSession(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'not_authenticated' });
      return;
    }
    if (user.termsAcceptedVersion !== CURRENT_TERMS_VERSION && !TERMS_EXEMPT_PATHS.has(req.path)) {
      res.status(403).json({ success: false, error: 'terms_not_accepted' });
      return;
    }
    req.userId = user.id;
    req.user   = user;
    next();
  } catch (err) { sessionError(res, err); }
}

// Ekip görünümü: ofis yöneticisi (manager) veya admin. Kullanım koşulları şartı
// requireUserAuth ile aynı.
export async function requireManager(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await resolveSession(req);
    if (!user) { res.status(401).json({ success: false, error: 'not_authenticated' }); return; }
    if (user.role !== 'admin' && user.role !== 'manager') { res.status(403).json({ success: false, error: 'manager_only' }); return; }
    if (user.termsAcceptedVersion !== CURRENT_TERMS_VERSION) { res.status(403).json({ success: false, error: 'terms_not_accepted' }); return; }
    req.userId = user.id;
    req.user   = user;
    next();
  } catch (err) { sessionError(res, err); }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await resolveSession(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'not_authenticated' });
      return;
    }
    if (user.role !== 'admin') {
      res.status(403).json({ success: false, error: 'admin_only' });
      return;
    }
    req.userId = user.id;
    req.user   = user;
    next();
  } catch (err) { sessionError(res, err); }
}

export async function getSessionUser(req: Request, res: Response): Promise<void> {
  try {
    const user = await resolveSession(req);
    if (!user) { res.status(401).json({ success: false, error: 'not_authenticated' }); return; }
    res.json({ success: true, data: user });
  } catch (err) { sessionError(res, err); }
}

// Süresi dolmuş oturumları toplu siler. resolveSession zaten süresi geçmiş bir
// oturumu okurken siliyor — ama bu SADECE o kullanıcı tekrar uğrarsa olur. Bir
// daha hiç giriş yapmayan birinin kaydı sonsuza dek kalırdı. Açılışta ve günde
// bir çalıştırılır; silinen satır sayısını döner.
export async function cleanupExpiredSessions(): Promise<number> {
  const { rowCount } = await pool.query('DELETE FROM user_sessions WHERE expires_at < NOW()');
  return rowCount ?? 0;
}
