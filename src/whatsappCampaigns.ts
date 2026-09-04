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
    errorMessage: r.error_message, createdAt: r.created_at.toISOString(),
  };
}

export async function getMessagesForLead(userId: string, leadId: string): Promise<WhatsappMessage[]> {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_messages WHERE lead_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [leadId, userId],
  );
  return rows.map(rowToMessage);
}

export async function sendSingleMessage(userId: string, leadId: string, body: string): Promise<WhatsappMessage> {
  const config = await getUserWhatsappConfig(userId);
  if (!config) throw new Error('WhatsApp hesap bilgileriniz tanımlı değil — Ayarlarım sayfasından ekleyin.');
  const { rows: leadRows } = await pool.query(`SELECT data FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
  const lead = leadRows[0]?.data as Lead | undefined;
  if (!lead?.phone) throw new Error('Adayın telefon numarası yok');

  const id = newId('wam');
  try {
    const sent = await sendWhatsAppMessage(config, lead.phone, body);
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_messages (id, user_id, lead_id, twilio_sid, direction, status, body)
       VALUES ($1, $2, $3, $4, 'OUT', 'SENT', $5) RETURNING *`,
      [id, userId, leadId, sent.sid, body],
    );
    await pool.query(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'MESSAGE_SENT', $4)`,
      [newId('act'), leadId, userId, JSON.stringify({ body })],
    );
    return rowToMessage(rows[0]);
  } catch (err) {
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_messages (id, user_id, lead_id, direction, status, body, error_message)
       VALUES ($1, $2, $3, 'OUT', 'FAILED', $4, $5) RETURNING *`,
      [id, userId, leadId, body, String((err as Error).message || err)],
    );
    return rowToMessage(rows[0]);
  }
}

// Twilio inbound webhook'undan çağrılır — telefon numarasına göre en son eşleşen
// adayı bulur (dedup için Twilio SID kontrolü de yapılır).
export async function recordInboundMessage(userId: string, fromPhone: string, body: string, twilioSid: string): Promise<void> {
  const dupe = await pool.query(`SELECT 1 FROM whatsapp_messages WHERE twilio_sid = $1`, [twilioSid]);
  if (dupe.rows[0]) return;

  const normalized = fromPhone.replace(/^whatsapp:/, '');
  const { rows: leadRows } = await pool.query(
    `SELECT id FROM leads WHERE user_id = $1 AND data->>'phone' = $2 ORDER BY updated_at DESC LIMIT 1`,
    [userId, normalized],
  );
  if (!leadRows[0]) {
    console.warn(`[whatsapp] Gelen mesaj eşleşen adayı bulunamadı: ${normalized}`);
    return;
  }
  const leadId = leadRows[0].id;
  await pool.query(
    `INSERT INTO whatsapp_messages (id, user_id, lead_id, twilio_sid, direction, status, body)
     VALUES ($1, $2, $3, $4, 'IN', 'RECEIVED', $5)`,
    [newId('wam'), userId, leadId, twilioSid, body],
  );
  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'MESSAGE_RECEIVED', $4)`,
    [newId('act'), leadId, userId, JSON.stringify({ body })],
  );
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
