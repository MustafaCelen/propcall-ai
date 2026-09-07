// PropCall AI / RLM — Şahsi WhatsApp bağlantısı (WhatsApp Web protokolü, Baileys).
//
// ⚠️ KASITLI KISIT — SADECE BİRE-BİR KULLANIM İÇİN: Bu modül resmi olmayan, tersine
// mühendislik edilmiş bir protokolü (WhatsApp Web) kullanır — WhatsApp'ın kendi
// istemcisi değildir. Toplu/otomatik gönderim (kampanyalar) BURADAN ASLA yapılmaz,
// SADECE Twilio Business API üzerinden gider (bkz. whatsappCampaigns.ts sendCampaign —
// bu modülü hiç import etmez). Bu ayrım, gerçek bir hesap-ban riskini kabul edilebilir
// seviyede tutmak için mimari düzeyde zorunlu kılınmıştır, sadece bir kural değil.
//
// Oturum (creds/keys) dosya sistemine değil DB'ye yazılır — Railway container'ları
// her deploy'da sıfırlanır, dosya tabanlı depo her deploy'da yeniden QR gerektirirdi.

import makeWASocket, {
  DisconnectReason, AuthenticationCreds, AuthenticationState,
  BufferJSON, initAuthCreds, WASocket, proto,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import pool from './db';
import { recordInboundMessage } from './whatsappCampaigns';

interface Session {
  socket: WASocket;
  status: 'qr_pending' | 'connected' | 'disconnected';
  qrDataUrl: string | null;
  phoneNumber: string | null;
}

const sessions = new Map<string, Session>();

async function loadDbAuthState(userId: string): Promise<{ state: AuthenticationState; saveState: () => Promise<void> }> {
  const { rows } = await pool.query(`SELECT creds, keys FROM whatsapp_personal_sessions WHERE user_id = $1`, [userId]);
  const creds: AuthenticationCreds = rows[0]?.creds
    ? JSON.parse(JSON.stringify(rows[0].creds), BufferJSON.reviver)
    : initAuthCreds();
  const keysData: Record<string, Record<string, any>> = rows[0]?.keys
    ? JSON.parse(JSON.stringify(rows[0].keys), BufferJSON.reviver)
    : {};

  const saveState = async () => {
    await pool.query(
      `INSERT INTO whatsapp_personal_sessions (user_id, creds, keys, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET creds = $2, keys = $3, updated_at = NOW()`,
      [userId, JSON.stringify(creds, BufferJSON.replacer), JSON.stringify(keysData, BufferJSON.replacer)],
    );
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result: Record<string, any> = {};
        for (const id of ids) {
          let value = keysData[type]?.[id];
          if (value && type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value !== undefined) result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        for (const category of Object.keys(data)) {
          keysData[category] = keysData[category] || {};
          Object.assign(keysData[category], (data as any)[category]);
        }
        await saveState();
      },
    },
  };

  return { state, saveState };
}

export async function connectPersonalWhatsapp(userId: string): Promise<void> {
  if (sessions.get(userId)?.status === 'connected') return;

  const { state, saveState } = await loadDbAuthState(userId);
  const socket = makeWASocket({ auth: state, printQRInTerminal: false });

  const session: Session = { socket, status: 'qr_pending', qrDataUrl: null, phoneNumber: null };
  sessions.set(userId, session);

  socket.ev.on('creds.update', saveState);

  socket.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      session.qrDataUrl = await QRCode.toDataURL(qr);
      session.status = 'qr_pending';
      await pool.query(`UPDATE whatsapp_personal_sessions SET status = 'qr_pending' WHERE user_id = $1`, [userId]);
    }
    if (connection === 'open') {
      session.status = 'connected';
      session.qrDataUrl = null;
      session.phoneNumber = socket.user?.id?.split(':')[0] || null;
      await pool.query(
        `UPDATE whatsapp_personal_sessions SET status = 'connected', phone_number = $2 WHERE user_id = $1`,
        [userId, session.phoneNumber],
      );
      console.log(`[whatsapp-personal] ${userId} bağlandı: ${session.phoneNumber}`);
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      sessions.delete(userId);
      if (loggedOut) {
        await pool.query(`DELETE FROM whatsapp_personal_sessions WHERE user_id = $1`, [userId]);
        console.log(`[whatsapp-personal] ${userId} oturumu kapattı (logged out) — DB temizlendi`);
      } else {
        await pool.query(`UPDATE whatsapp_personal_sessions SET status = 'disconnected' WHERE user_id = $1`, [userId]);
        console.warn(`[whatsapp-personal] ${userId} bağlantısı koptu (kod: ${statusCode}) — yeniden bağlanmak için tekrar bağlan`);
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const fromPhone = msg.key.remoteJid?.split('@')[0];
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!fromPhone || !body) continue;
      await recordInboundMessage(userId, fromPhone, body, msg.key.id || `personal_${Date.now()}`, 'PERSONAL')
        .catch(err => console.error('[whatsapp-personal] Gelen mesaj kaydı hatası:', err));
    }
  });
}

export function getPersonalStatus(userId: string): { status: string; qrDataUrl: string | null; phoneNumber: string | null } {
  const s = sessions.get(userId);
  if (!s) return { status: 'disconnected', qrDataUrl: null, phoneNumber: null };
  return { status: s.status, qrDataUrl: s.qrDataUrl, phoneNumber: s.phoneNumber };
}

export async function disconnectPersonalWhatsapp(userId: string): Promise<void> {
  const s = sessions.get(userId);
  if (s) {
    try { await s.socket.logout(); } catch (_) { /* zaten kopmuş olabilir */ }
    sessions.delete(userId);
  }
  await pool.query(`DELETE FROM whatsapp_personal_sessions WHERE user_id = $1`, [userId]);
}

// Sadece bire-bir mesaj — BİLİNÇLİ olarak toplu/döngüsel çağrı için tasarlanmadı,
// bkz. dosya başındaki kısıt notu.
export async function sendPersonalMessage(userId: string, phone: string, body: string): Promise<void> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') throw new Error('Şahsi WhatsApp bağlı değil — Ayarlarım sayfasından QR kodu okutun.');
  const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await s.socket.sendMessage(jid, { text: body });
}

// Sunucu (yeniden) başladığında, daha önce bağlanmış (DB'de session kaydı olan)
// kullanıcılar için soketi otomatik yeniden kurar — QR tekrar okutmaya gerek kalmaz
// (deploy sonrası bağlantının kopmaması, campaign engine'in aktif kampanyaları
// yeniden yüklemesiyle aynı desen).
export async function reconnectAllPersonalSessions(): Promise<void> {
  const { rows } = await pool.query(`SELECT user_id FROM whatsapp_personal_sessions WHERE status = 'connected'`);
  for (const r of rows) {
    connectPersonalWhatsapp(r.user_id).catch(err =>
      console.error(`[whatsapp-personal] ${r.user_id} yeniden bağlanamadı:`, err));
  }
  if (rows.length) console.log(`[whatsapp-personal] ${rows.length} şahsi oturum yeniden bağlanıyor...`);
}
