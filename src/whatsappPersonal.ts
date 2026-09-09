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
  BufferJSON, initAuthCreds, WASocket, proto, jidDecode,
  type WAMessage,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import pool from './db';
import { recordChannelMessage } from './whatsappCampaigns';

// remoteJid'den (örn. "905321234567:12@s.whatsapp.net") gerçek telefon numarasını
// çıkarır — jidDecode cihaz sonekini (":12") ve sunucu kısmını (@s.whatsapp.net) temizler.
//
// KRİTİK — grup/broadcast/LID filtresi: remoteJid SADECE bire-bir sohbetlerde
// (server === 's.whatsapp.net') gerçek bir telefon numarasıdır. WhatsApp GRUPLARI
// (@g.us, "120363...@g.us" gibi 18 haneli veya eski "telefon-zaman@g.us" formatı),
// yayın listeleri (@broadcast) ve LID (yeni opak kimlik, telefon numarası taşımaz)
// buradan ASLA geçmemeli — önceki sürüm bunları filtrelemiyordu, sonucu: kullanıcının
// üye olduğu WhatsApp grupları (bazılarında binlerce mesaj) "aday" olarak DB'ye
// aktı, grup ID'leri "telefon numarası" diye kaydedildi ("anlamsız numaralar" bug'ı).
async function extractPhoneFromMessage(socket: WASocket, msg: WAMessage): Promise<string | null> {
  const jid = msg.key.remoteJid;
  if (!jid) return null;
  const decoded = jidDecode(jid);
  if (!decoded?.user) return null;
  if (decoded.server === 'g.us' || decoded.server === 'broadcast' || decoded.server === 'newsletter') return null;
  if (decoded.server === 'lid') {
    // LID (Linked ID) — WhatsApp'ın telefon numarası taşımayan opak kimlik sistemi.
    // Gerçek numarayı çözmenin resmi yolu Baileys'in signalRepository.lidMapping'i —
    // önceki sürüm var olmayan bir msg.key.remoteJidAlt alanına bakıyordu (her zaman
    // null dönüyordu), bu yüzden LID'li her mesaj sessizce atlanıyordu.
    const pn = await socket.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
    if (!pn) return null;
    const pnDecoded = jidDecode(pn);
    return pnDecoded?.user && pnDecoded.server === 's.whatsapp.net' ? pnDecoded.user : null;
  }
  if (decoded.server !== 's.whatsapp.net') return null;
  return decoded.user;
}

// ÖNEMLİ — medya/sesli mesaj boşluğu: sadece conversation/extendedTextMessage okunuyordu,
// yani resim, sesli mesaj, video, belge, konum, kişi kartı ve sticker'lar metin
// çıkarılamadığı için processPersonalMessage'da SESSİZCE atlanıyordu — DB'ye hiç
// düşmüyordu, sohbet geçmişinde bir "boşluk" olarak kalıyordu (emlak işinde mülk
// fotoğrafı/konum paylaşımı gibi kritik içerikler kaybolabiliyordu). Artık her tip için
// görünür bir yer tutucu (+ varsa caption) döndürülüyor, hiçbir mesaj sessizce kaybolmaz.
function extractMessageText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : '📷 Resim';
  if (m.videoMessage) return m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : '🎥 Video';
  if (m.audioMessage) return m.audioMessage.ptt ? '🎤 Sesli mesaj' : '🎵 Ses dosyası';
  if (m.documentMessage) {
    return m.documentMessage.caption
      ? `📄 ${m.documentMessage.caption}`
      : `📄 Belge${m.documentMessage.fileName ? ': ' + m.documentMessage.fileName : ''}`;
  }
  if (m.stickerMessage) return '😀 Sticker';
  if (m.locationMessage) return '📍 Konum paylaşıldı';
  if (m.contactMessage) return `👤 Kişi kartı${m.contactMessage.displayName ? ': ' + m.contactMessage.displayName : ''}`;
  return '';
}

interface Session {
  socket: WASocket;
  status: 'connecting' | 'qr_pending' | 'connected' | 'disconnected';
  qrDataUrl: string | null;
  phoneNumber: string | null;
}

const sessions = new Map<string, Session>();

// creds küçük (birkaç KB, nadiren değişir) — tek JSONB blob olarak kalıyor.
// keys (Signal protokolü oturum anahtarları) ARTIK whatsapp_personal_keys'te satır
// bazlı — sebep için tablo tanımındaki yorum (db.ts) bkz.: eski tek-blob yaklaşımı
// her mesajda TÜM anahtar deposunu (staging'de sadece birkaç günde ~465KB'a ulaştı)
// yeniden yazıyordu.
async function loadDbAuthState(userId: string): Promise<{ state: AuthenticationState; saveState: () => Promise<void> }> {
  const { rows } = await pool.query(`SELECT creds FROM whatsapp_personal_sessions WHERE user_id = $1`, [userId]);
  const creds: AuthenticationCreds = rows[0]?.creds
    ? JSON.parse(JSON.stringify(rows[0].creds), BufferJSON.reviver)
    : initAuthCreds();

  const saveState = async () => {
    await pool.query(
      `INSERT INTO whatsapp_personal_sessions (user_id, creds, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET creds = $2, updated_at = NOW()`,
      [userId, JSON.stringify(creds, BufferJSON.replacer)],
    );
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        if (!ids.length) return {};
        const { rows } = await pool.query(
          `SELECT key_id, value FROM whatsapp_personal_keys WHERE user_id = $1 AND category = $2 AND key_id = ANY($3)`,
          [userId, type, ids],
        );
        const result: Record<string, any> = {};
        for (const r of rows) {
          let value = JSON.parse(JSON.stringify(r.value), BufferJSON.reviver);
          if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
          result[r.key_id] = value;
        }
        return result;
      },
      // KRİTİK — her çağrıda SADECE değişen anahtarları yazar (eski davranış: her
      // çağrıda TÜM anahtar deposunu yeniden serialize edip yazıyordu). Baileys null
      // değer vererek bir anahtarın silinmesini işaret eder — bu satırları upsert
      // etmek yerine gerçekten DB'den siliyoruz, aksi halde tablo "hayalet" (tombstone)
      // satırlarla şişer.
      set: async (data) => {
        const upserts: Array<{ category: string; keyId: string; json: string }> = [];
        const deletes: Array<{ category: string; keyId: string }> = [];
        for (const category of Object.keys(data)) {
          const catData = (data as any)[category];
          for (const keyId of Object.keys(catData)) {
            const value = catData[keyId];
            if (value === null || value === undefined) {
              deletes.push({ category, keyId });
            } else {
              upserts.push({ category, keyId, json: JSON.stringify(value, BufferJSON.replacer) });
            }
          }
        }
        if (upserts.length) {
          const values: unknown[] = [userId];
          const rowSql = upserts.map(u => {
            values.push(u.category, u.keyId, u.json);
            const n = values.length;
            return `($1, $${n - 2}, $${n - 1}, $${n}::jsonb, NOW())`;
          }).join(', ');
          await pool.query(
            `INSERT INTO whatsapp_personal_keys (user_id, category, key_id, value, updated_at)
             VALUES ${rowSql}
             ON CONFLICT (user_id, category, key_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            values,
          );
        }
        for (const d of deletes) {
          await pool.query(
            `DELETE FROM whatsapp_personal_keys WHERE user_id = $1 AND category = $2 AND key_id = $3`,
            [userId, d.category, d.keyId],
          );
        }
      },
    },
  };

  return { state, saveState };
}

// ÖNEMLİ — çakışan bağlantı bug'ı (üretimde gözlemlendi): eskiden bu fonksiyon sadece
// 'connected' durumunda erken çıkıyordu — 'qr_pending' sırasında tekrar çağrılırsa
// (örn. kullanıcı butona birden fazla kez basarsa) HER seferinde YENİ bir Baileys
// soketi açılıyor, aynı numarayla eş zamanlı birden fazla "cihaz" eşleşmeye çalışıyordu.
// WhatsApp bunu algılayıp "device_removed" çakışmasıyla oturumu anında kapatıyordu —
// hem oturum sürekli kopuyordu hem de aynı process'te onlarca eş zamanlı soket/DB
// yazımı yüzünden tüm uygulama yavaşlıyordu ("takılıyor" şikayeti buradan). Artık
// 'connecting' durumu da erken-çıkış listesinde.
export async function connectPersonalWhatsapp(userId: string): Promise<void> {
  const existing = sessions.get(userId);
  if (existing && (existing.status === 'connected' || existing.status === 'qr_pending' || existing.status === 'connecting')) return;

  const { state, saveState } = await loadDbAuthState(userId);
  // syncFullHistory:true — bu olmadan WhatsApp ilk eşleşmede SADECE yakın zamanlı, kısıtlı
  // bir geçmiş gönderiyor ("mesajlar geçmişle tam yüklenmiyor" şikayetinin sebebi), telefonun
  // yıllara yayılan tam sohbet geçmişini değil. ÖNEMLİ: bu ayar sadece YENİ bir eşleşmede
  // (yeni QR okutma) etkilidir — zaten bağlı bir oturum için WhatsApp geçmiş senkron
  // anlaşmasını ilk eşleşmede tamamlamıştır, geriye dönük olarak daha fazla geçmiş çekmez.
  const socket = makeWASocket({ auth: state, printQRInTerminal: false, syncFullHistory: true });

  const session: Session = { socket, status: 'connecting', qrDataUrl: null, phoneNumber: null };
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
        await pool.query(`DELETE FROM whatsapp_personal_keys WHERE user_id = $1`, [userId]);
        console.log(`[whatsapp-personal] ${userId} oturumu kapattı (logged out) — DB temizlendi`);
      } else {
        // Kod 515 ("restart required") ilk eşleşmeden hemen sonra Baileys/WhatsApp'ın
        // BEKLENEN, normal davranışıdır — resmi Baileys örnek kodu da bunu logout
        // saymadan otomatik yeniden bağlanarak ele alır. Aksi halde kullanıcı arayüzde
        // "bağlı" görüp saniyeler sonra sessizce "bağlantısız" kalırdı.
        await pool.query(`UPDATE whatsapp_personal_sessions SET status = 'disconnected' WHERE user_id = $1`, [userId]);
        console.warn(`[whatsapp-personal] ${userId} bağlantısı koptu (kod: ${statusCode}) — otomatik yeniden bağlanılıyor`);
        setTimeout(() => connectPersonalWhatsapp(userId).catch(err =>
          console.error(`[whatsapp-personal] ${userId} otomatik yeniden bağlanma hatası:`, err)), 2000);
      }
    }
  });

  // Yeni mesajlar (canlı) — HEM gelen HEM telefonun kendisinden (WhatsApp uygulamasından,
  // bu uygulama dışından) atılan giden mesajlar. Önceden fromMe=true olanlar atlanıyordu —
  // "giden mesajlar hiç görünmüyor" şikayetinin kaynağı buydu: sadece bu uygulama
  // üzerinden gönderilenler kaydediliyordu, telefondan elle yazılanlar yoktu.
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      await processPersonalMessage(userId, socket, msg).catch(err =>
        console.error('[whatsapp-personal] Mesaj kaydı hatası:', err));
    }
  });

  // İlk bağlantıda WhatsApp geçmiş sohbetleri tek seferlik gönderir (history sync) —
  // bu olmadan sadece bağlandıktan SONRA gelen mesajlar görünürdü, geçmiş boş kalırdı.
  socket.ev.on('messaging-history.set', async ({ messages }) => {
    let imported = 0;
    for (const msg of messages) {
      const ok = await processPersonalMessage(userId, socket, msg, true).catch(err => {
        console.error('[whatsapp-personal] Geçmiş mesaj kaydı hatası:', err);
        return false;
      });
      if (ok) imported++;
    }
    if (imported) console.log(`[whatsapp-personal] ${userId}: ${imported} geçmiş mesaj içe aktarıldı`);
  });
}

async function processPersonalMessage(userId: string, socket: WASocket, msg: WAMessage, isHistory = false): Promise<boolean> {
  if (!msg.message) return false;
  const fromPhone = await extractPhoneFromMessage(socket, msg);
  const body = extractMessageText(msg);
  if (!fromPhone || !body) return false;

  const direction = msg.key.fromMe ? 'OUT' : 'IN';
  const ts = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();
  const externalId = msg.key.id || `personal_${isHistory ? 'hist_' : ''}${fromPhone}_${ts.getTime()}`;

  await recordChannelMessage(userId, {
    fromPhone, body, externalId, channel: 'PERSONAL', direction, timestamp: ts,
    contactName: direction === 'IN' ? (msg.pushName || undefined) : undefined,
  });
  return true;
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
  await pool.query(`DELETE FROM whatsapp_personal_keys WHERE user_id = $1`, [userId]);
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
