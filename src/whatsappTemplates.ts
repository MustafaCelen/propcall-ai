// PropCall AI / RLM — WhatsApp şablon CRUD + Twilio onay durumu senkronu.
// leads.ts ile aynı desen (id + tipli sütunlar + user_id).

import pool from './db';
import { WhatsappTemplate, TemplateCategory } from './types';
import { getUserWhatsappConfig } from './users';
import { submitTemplateForApproval, getApprovalStatus } from './whatsapp';

function newTemplateId(): string {
  return 'tpl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function rowToTemplate(r: any): WhatsappTemplate {
  return {
    id: r.id, name: r.name, category: r.category, body: r.body,
    variables: r.variables || [], twilioContentSid: r.twilio_content_sid,
    rejectionReason: r.rejection_reason, status: r.status,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

export async function getAllTemplates(userId: string): Promise<WhatsappTemplate[]> {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_templates WHERE user_id = $1 ORDER BY created_at DESC`, [userId],
  );
  return rows.map(rowToTemplate);
}

export async function getTemplate(userId: string, id: string): Promise<WhatsappTemplate | null> {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_templates WHERE id = $1 AND user_id = $2`, [id, userId],
  );
  return rows[0] ? rowToTemplate(rows[0]) : null;
}

export async function createTemplate(
  userId: string, name: string, category: TemplateCategory, body: string, variables: string[],
): Promise<WhatsappTemplate> {
  const id = newTemplateId();
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_templates (id, user_id, name, category, body, variables)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, userId, name.trim(), category, body.trim(), JSON.stringify(variables)],
  );
  return rowToTemplate(rows[0]);
}

export async function updateTemplate(
  userId: string, id: string, patch: { name?: string; body?: string; variables?: string[] },
): Promise<WhatsappTemplate | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id, userId];
  if (patch.name !== undefined)      { vals.push(patch.name);                    sets.push(`name = $${vals.length}`); }
  if (patch.body !== undefined)      { vals.push(patch.body);                    sets.push(`body = $${vals.length}`); }
  if (patch.variables !== undefined) { vals.push(JSON.stringify(patch.variables)); sets.push(`variables = $${vals.length}`); }
  if (!sets.length) return getTemplate(userId, id);
  sets.push(`updated_at = NOW()`);
  const { rows } = await pool.query(
    `UPDATE whatsapp_templates SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`, vals,
  );
  return rows[0] ? rowToTemplate(rows[0]) : null;
}

export async function deleteTemplate(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM whatsapp_templates WHERE id = $1 AND user_id = $2`, [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function submitTemplate(userId: string, id: string): Promise<WhatsappTemplate> {
  const config = await getUserWhatsappConfig(userId);
  if (!config) throw new Error('WhatsApp hesap bilgileriniz tanımlı değil — Ayarlarım sayfasından ekleyin.');
  const template = await getTemplate(userId, id);
  if (!template) throw new Error('Şablon bulunamadı');

  const contentSid = await submitTemplateForApproval(config, template);
  const { rows } = await pool.query(
    `UPDATE whatsapp_templates SET twilio_content_sid = $3, status = 'PENDING_APPROVAL', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, contentSid],
  );
  return rowToTemplate(rows[0]);
}

// Onay bekleyen TÜM kullanıcıların şablonlarını tarar — global arka plan görevi.
async function syncPendingTemplates(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, t.name, t.twilio_content_sid
     FROM whatsapp_templates t WHERE t.status = 'PENDING_APPROVAL' AND t.twilio_content_sid IS NOT NULL`,
  );
  for (const t of rows) {
    try {
      const config = await getUserWhatsappConfig(t.user_id);
      if (!config) continue;
      const result = await getApprovalStatus(config, t.twilio_content_sid);
      if (!result || result.status === 'PENDING_APPROVAL') continue;
      await pool.query(
        `UPDATE whatsapp_templates SET status = $2, rejection_reason = $3, updated_at = NOW() WHERE id = $1`,
        [t.id, result.status, result.rejectionReason],
      );
      console.log(`[template-sync] ${t.name}: ${result.status}`);
    } catch (err) {
      console.error('[template-sync] Şablon senkron hatası', t.id, err);
    }
  }
}

export function startTemplateSyncJob(): void {
  setTimeout(() => {
    syncPendingTemplates().catch(err => console.error('[template-sync] İlk senkron hatası', err));
  }, 60_000);
  setInterval(() => {
    syncPendingTemplates().catch(err => console.error('[template-sync] Periyodik senkron hatası', err));
  }, 30 * 60 * 1000);
  console.log('[template-sync] Şablon onay senkronu başlatıldı (30 dk aralıklı)');
}
