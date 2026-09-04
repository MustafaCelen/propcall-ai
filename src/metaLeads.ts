// PropCall AI / RLM — Meta Lead Ads senkronizasyonu. rlm2/server/meta-sync.ts'in
// doğrudan algoritmik portu (workspaceId → userId, storage.createLead → leads.ts createLead).
// Danışman Meta Business'tan aldığı Page Access Token'ı elle bağlar (bkz. users.ts
// setUserMetaConfig) — tam OAuth akışı için ayrı bir Meta App kaydı gerekir, kapsam dışı.

import { getAllUsersWithMetaConfig, setUserMetaLastSync, MetaConfig } from './users';
import { createLead } from './leads';
import pool from './db';

async function getLeadByMetaLeadId(metaLeadId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM leads WHERE meta_lead_id = $1`, [metaLeadId]);
  return !!rows[0];
}

async function syncForm(userId: string, config: MetaConfig, formId: string, formName: string): Promise<number> {
  const sinceParam = config.lastSyncAt
    ? `&filtering=[{"field":"time_created","operator":"GREATER_THAN","value":${Math.floor(new Date(config.lastSyncAt).getTime() / 1000)}}]`
    : '';

  let url: string | null =
    `https://graph.facebook.com/v19.0/${formId}/leads?access_token=${config.pageAccessToken}&limit=100&fields=id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name${sinceParam}`;

  let imported = 0;

  while (url) {
    const resp = await fetch(url);
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      console.error('[meta-sync] Form sync hatası', formId, resp.status, JSON.stringify(errData));
      break;
    }

    const data: any = await resp.json();

    for (const leadData of data.data ?? []) {
      if (await getLeadByMetaLeadId(String(leadData.id))) continue;

      const fields: Record<string, string> = {};
      for (const f of leadData.field_data ?? []) {
        fields[f.name] = f.values?.[0] ?? '';
      }

      let firstName = fields.first_name || fields.full_name || fields.name || 'Bilinmiyor';
      let lastName: string | null = fields.last_name || null;
      if (!fields.first_name && (fields.full_name || fields.name)) {
        const parts = (fields.full_name ?? fields.name ?? '').trim().split(/\s+/);
        firstName = parts[0] || 'Bilinmiyor';
        lastName = parts.slice(1).join(' ') || null;
      }

      await createLead(userId, {
        firstName,
        lastName,
        email: fields.email || null,
        phone: fields.phone_number || fields.phone || null,
        source: 'META_LEAD_AD',
        metaLeadId: String(leadData.id),
        adData: {
          formId, formName,
          adId: leadData.ad_id || null,
          adName: leadData.ad_name || null,
          adsetId: leadData.adset_id || null,
          adsetName: leadData.adset_name || null,
          campaignId: leadData.campaign_id || null,
          campaignName: leadData.campaign_name || null,
        },
      });
      imported++;
    }

    url = data.paging?.next ?? null;
  }

  return imported;
}

async function syncUser(userId: string, config: MetaConfig): Promise<void> {
  if (!config.pageId || !config.pageAccessToken) return;

  try {
    const formsResp = await fetch(
      `https://graph.facebook.com/v19.0/${config.pageId}/leadgen_forms?access_token=${config.pageAccessToken}&fields=id,name,status&limit=100`,
    );
    if (!formsResp.ok) {
      const errData = await formsResp.json().catch(() => ({}));
      console.error('[meta-sync] Form listesi alınamadı', userId, JSON.stringify(errData));
      return;
    }

    const formsData: any = await formsResp.json();
    const forms: Array<{ id: string; name: string }> = formsData.data ?? [];

    let totalImported = 0;
    for (const form of forms) {
      totalImported += await syncForm(userId, config, form.id, form.name);
    }

    await setUserMetaLastSync(userId);
    if (totalImported > 0) {
      console.log(`[meta-sync] Kullanıcı ${userId}: ${totalImported} yeni aday, ${forms.length} form tarandı`);
    }
  } catch (err) {
    console.error('[meta-sync] Senkron hatası', userId, err);
  }
}

export async function syncUserMetaLeadsNow(userId: string, config: MetaConfig): Promise<void> {
  await syncUser(userId, config);
}

async function syncAllUsers(): Promise<void> {
  const configs = await getAllUsersWithMetaConfig();
  for (const c of configs) {
    await syncUser(c.userId, c);
  }
}

export function startMetaSyncJob(): void {
  setTimeout(() => {
    syncAllUsers().catch(err => console.error('[meta-sync] İlk senkron hatası', err));
  }, 30_000);

  setInterval(() => {
    syncAllUsers().catch(err => console.error('[meta-sync] Periyodik senkron hatası', err));
  }, 15 * 60 * 1000);

  console.log('[meta-sync] Senkron görevi başlatıldı (15 dk aralıklı)');
}
