// PropCall AI / RLM — WhatsApp mesaj kayıtları + toplu kampanya gönderimi.
// rlm2/server/routes.ts:355-413'teki senkron gönderim döngüsünün portu — arama
// motorunun eşzamanlılık-slotlu async motoruna (campaign.ts) İHTİYAÇ YOK, WhatsApp
// gönderimi hızlı ve senkron; rlm2'nin kendi (doğru) tasarım tercihiyle aynı.

import pool from './db';
import { WhatsappMessage, WhatsappCampaign, WhatsappCampaignFilter, Lead } from './types';
import { getUserWhatsappConfig } from './users';
import { sendWhatsAppMessage } from './whatsapp';
import { getTemplate } from './whatsappTemplates';

function newId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function renderTemplate(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  return out;
}

// ─── Mesajlar (aday bazlı thread) ────────────────────────────────────────────

function rowToMessage(r: any): WhatsappMessage {
  return {
    id: r.id, leadId: r.lead_id, twilioSid: r.twilio_sid, direction: r.direction,
    status: r.status, body: r.body, templateId: r.template_id, campaignId: r.campaign_id,
    errorMessage: r.error_message, channel: r.channel, createdAt: r.created_at.toISOString(),
  };
}

// WhatsApp Web tarzı gelen kutusu — konuşması olan TÜM adayları en son mesaja göre
// sıralar (kanal fark etmeksizin, Twilio + şahsi hep aynı listede).
export interface InboxEntry {
  leadId: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  lastMessage: string;
  lastDirection: string;
  lastChannel: string;
  lastAt: string;
}

export async function getInbox(userId: string): Promise<InboxEntry[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (m.lead_id)
       m.lead_id, l.data->>'firstName' AS "firstName", l.data->>'lastName' AS "lastName",
       l.data->>'phone' AS phone, m.body, m.direction, m.channel, m.created_at
     FROM whatsapp_messages m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.user_id = $1
     ORDER BY m.lead_id, m.created_at DESC`,
    [userId],
  );
  return rows
    .map(r => ({
      leadId: r.lead_id, firstName: r.firstName, lastName: r.lastName, phone: r.phone,
      lastMessage: r.body, lastDirection: r.direction, lastChannel: r.channel,
      lastAt: r.created_at.toISOString(),
    }))
    .sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
}

export async function getMessagesForLead(userId: string, leadId: string): Promise<WhatsappMessage[]> {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_messages WHERE lead_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [leadId, userId],
  );
  return rows.map(rowToMessage);
}

// channel='PERSONAL' SADECE bire-bir bu fonksiyon üzerinden çağrılabilir — toplu
// kampanya motoru (sendCampaign, aşağıda) bu parametreyi hiç kullanmaz/kullanamaz,
// her zaman 'TWILIO'dur. Bkz. whatsappPersonal.ts başındaki kısıt notu.
export async function sendSingleMessage(
  userId: string, leadId: string, body: string, channel: 'TWILIO' | 'PERSONAL' = 'TWILIO',
): Promise<WhatsappMessage> {
  const { rows: leadRows } = await pool.query(`SELECT data FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
  const lead = leadRows[0]?.data as Lead | undefined;
  if (!lead?.phone) throw new Error('Adayın telefon numarası yok');

  const id = newId('wam');
  try {
    let twilioSid: string | null = null;
    if (channel === 'PERSONAL') {
      const { sendPersonalMessage } = await import('./whatsappPersonal');
      await sendPersonalMessage(userId, lead.phone, body);
    } else {
      const config = await getUserWhatsappConfig(userId);
      if (!config) throw new Error('WhatsApp hesap bilgileriniz tanımlı değil — Ayarlarım sayfasından ekleyin.');
      const sent = await sendWhatsAppMessage(config, lead.phone, body);
      twilioSid = sent.sid;
    }
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_messages (id, user_id, lead_id, twilio_sid, direction, status, body, channel)
       VALUES ($1, $2, $3, $4, 'OUT', 'SENT', $5, $6) RETURNING *`,
      [id, userId, leadId, twilioSid, body, channel],
    );
    await pool.query(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'MESSAGE_SENT', $4)`,
      [newId('act'), leadId, userId, JSON.stringify({ body, channel })],
    );
    return rowToMessage(rows[0]);
  } catch (err) {
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_messages (id, user_id, lead_id, direction, status, body, error_message, channel)
       VALUES ($1, $2, $3, 'OUT', 'FAILED', $4, $5, $6) RETURNING *`,
      [id, userId, leadId, body, String((err as Error).message || err), channel],
    );
    return rowToMessage(rows[0]);
  }
}

// Twilio (channel='TWILIO', her zaman IN — Twilio webhook'u sadece gelen mesaj bildirir)
// veya şahsi hesap (channel='PERSONAL', bkz. whatsappPersonal.ts — HEM gelen HEM
// telefonun kendisinden atılan giden mesajlar) olaylarından çağrılır. Telefon
// numarasına göre en son eşleşen adayı bulur, yoksa yeni bir aday oluşturur —
// bir mesaj hiçbir zaman sessizce kaybolmaz.
//
// contactName: sadece IN mesajlarda WhatsApp'ın kendi gönderdiği görünen ad (Baileys'te
// pushName) — yeni aday oluşturulurken telefon numarası yerine gerçek isim kullanılsın
// diye. timestamp verilmezse (Twilio'da olduğu gibi) DB'nin NOW()'ı kullanılır; Baileys
// hem canlı hem GEÇMİŞ mesajlar için gerçek WhatsApp zaman damgasını verir — bunsuz
// geçmiş mesajlar hep "şimdi" ile kaydedilip sıralama bozulurdu.
export async function recordChannelMessage(userId: string, params: {
  fromPhone: string; body: string; externalId: string; channel: 'TWILIO' | 'PERSONAL';
  direction?: 'IN' | 'OUT'; contactName?: string; timestamp?: Date;
}): Promise<void> {
  const { fromPhone, body, externalId, channel } = params;
  const direction = params.direction ?? 'IN';
  const dupe = await pool.query(`SELECT 1 FROM whatsapp_messages WHERE twilio_sid = $1`, [externalId]);
  if (dupe.rows[0]) return;

  const normalized = fromPhone.replace(/^whatsapp:/, '').replace(/\D/g, '');
  // Savunma katmanı: E.164 gerçek telefon numaraları en fazla 15 hane olur (ITU
  // standardı). Grup/broadcast/LID JID'leri filtrelensin diye whatsappPersonal.ts'te
  // zaten engelleniyor ama burada da kontrol ederek olası başka bir kanaldan (ileride
  // eklenecek) benzer bir sızıntının "aday" olarak DB'ye akmasını önlüyoruz.
  if (normalized.length < 7 || normalized.length > 15) {
    console.warn(`[whatsapp] Geçersiz telefon formatı, mesaj atlandı: "${fromPhone}" (${channel})`);
    return;
  }
  const { rows: leadRows } = await pool.query(
    `SELECT id FROM leads WHERE user_id = $1 AND regexp_replace(data->>'phone', '\\D', '', 'g') = $2 ORDER BY updated_at DESC LIMIT 1`,
    [userId, normalized],
  );

  let leadId: string;
  if (leadRows[0]) {
    leadId = leadRows[0].id;
  } else {
    const { createLead } = await import('./leads');
    const created = await createLead(userId, {
      firstName: params.contactName?.trim() || ('+' + normalized),
      phone: '+' + normalized,
      source: 'OTHER',
    });
    leadId = created.id;
    console.log(`[whatsapp] Yeni mesaj için yeni aday oluşturuldu: ${fromPhone} (${channel})`);
  }

  await pool.query(
    `INSERT INTO whatsapp_messages (id, user_id, lead_id, twilio_sid, direction, status, body, channel, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))`,
    [newId('wam'), userId, leadId, externalId, direction, direction === 'IN' ? 'RECEIVED' : 'SENT', body, channel, params.timestamp ?? null],
  );
  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, $4, $5)`,
    [newId('act'), leadId, userId, direction === 'IN' ? 'MESSAGE_RECEIVED' : 'MESSAGE_SENT', JSON.stringify({ body, channel })],
  );
}

// Geriye dönük uyumluluk — Twilio webhook'u (server.ts) bunu çağırır, her zaman IN.
export async function recordInboundMessage(
  userId: string, fromPhone: string, body: string, externalId: string, channel: 'TWILIO' | 'PERSONAL' = 'TWILIO',
): Promise<void> {
  return recordChannelMessage(userId, { fromPhone, body, externalId, channel, direction: 'IN' });
}

// ─── Kampanyalar (toplu gönderim) ────────────────────────────────────────────

function rowToCampaign(r: any): WhatsappCampaign {
  return {
    id: r.id, name: r.name, templateId: r.template_id, status: r.status,
    filter: r.filter || {}, variableMap: r.variable_map || {},
    createdAt: r.created_at.toISOString(), completedAt: r.completed_at ? r.completed_at.toISOString() : null,
  };
}

export async function getAllCampaigns(userId: string): Promise<WhatsappCampaign[]> {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_campaigns WHERE user_id = $1 ORDER BY created_at DESC`, [userId],
  );
  return rows.map(rowToCampaign);
}

async function getLeadsForCampaign(userId: string, filter: WhatsappCampaignFilter): Promise<Array<{ id: string; phone: string; firstName: string }>> {
  const conditions = ['user_id = $1', `data->>'phone' IS NOT NULL`, `data->>'phone' != ''`];
  const vals: unknown[] = [userId];
  if (filter.stages?.length) { vals.push(filter.stages); conditions.push(`stage = ANY($${vals.length})`); }
  if (filter.sources?.length) { vals.push(filter.sources); conditions.push(`data->>'source' = ANY($${vals.length})`); }
  const { rows } = await pool.query(
    `SELECT id, data->>'phone' AS phone, data->>'firstName' AS "firstName" FROM leads WHERE ${conditions.join(' AND ')}`,
    vals,
  );
  return rows;
}

export async function previewCampaignRecipients(userId: string, filter: WhatsappCampaignFilter): Promise<number> {
  return (await getLeadsForCampaign(userId, filter)).length;
}

export async function createCampaign(
  userId: string, name: string, templateId: string, filter: WhatsappCampaignFilter, variableMap: Record<string, string>,
): Promise<WhatsappCampaign> {
  const id = newId('wac');
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_campaigns (id, user_id, name, template_id, filter, variable_map)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, userId, name.trim(), templateId, JSON.stringify(filter), JSON.stringify(variableMap)],
  );
  return rowToCampaign(rows[0]);
}

export async function sendCampaign(userId: string, campaignId: string): Promise<{ sent: number; failed: number; total: number }> {
  const config = await getUserWhatsappConfig(userId);
  if (!config) throw new Error('WhatsApp hesap bilgileriniz tanımlı değil — Ayarlarım sayfasından ekleyin.');

  const { rows: campRows } = await pool.query(
    `SELECT * FROM whatsapp_campaigns WHERE id = $1 AND user_id = $2`, [campaignId, userId],
  );
  const campaign = campRows[0];
  if (!campaign) throw new Error('Kampanya bulunamadı');
  if (campaign.status !== 'DRAFT') throw new Error('Sadece taslak kampanyalar gönderilebilir');

  const template = await getTemplate(userId, campaign.template_id);
  if (!template) throw new Error('Şablon bulunamadı');

  const leads = await getLeadsForCampaign(userId, campaign.filter || {});
  if (!leads.length) throw new Error('Seçilen filtreye uygun telefon numaralı aday bulunamadı');

  await pool.query(`UPDATE whatsapp_campaigns SET status = 'RUNNING' WHERE id = $1`, [campaignId]);

  let sent = 0, failed = 0;
  const variableMap = campaign.variable_map || {};
  for (const lead of leads) {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(variableMap as Record<string, string>)) {
      vars[k] = v === 'firstName' ? lead.firstName : v;
    }
    const body = renderTemplate(template.body, vars);
    const recipientId = newId('wcr');
    try {
      const result = await sendWhatsAppMessage(config, lead.phone, body);
      await pool.query(
        `INSERT INTO whatsapp_campaign_recipients (id, campaign_id, lead_id, status, sent_at) VALUES ($1, $2, $3, 'SENT', NOW())
         ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
        [recipientId, campaignId, lead.id],
      );
      await pool.query(
        `INSERT INTO whatsapp_messages (id, user_id, lead_id, twilio_sid, direction, status, body, template_id, campaign_id)
         VALUES ($1, $2, $3, $4, 'OUT', 'SENT', $5, $6, $7)`,
        [newId('wam'), userId, lead.id, result.sid, body, template.id, campaignId],
      );
      sent++;
    } catch (err) {
      await pool.query(
        `INSERT INTO whatsapp_campaign_recipients (id, campaign_id, lead_id, status, error_msg) VALUES ($1, $2, $3, 'FAILED', $4)
         ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
        [recipientId, campaignId, lead.id, String((err as Error).message || err)],
      );
      failed++;
    }
  }

  await pool.query(`UPDATE whatsapp_campaigns SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`, [campaignId]);
  return { sent, failed, total: leads.length };
}
