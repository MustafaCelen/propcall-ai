// PropCall AI / RLM — Adaylar (Leads) CRUD + Kanban aşama geçişleri + aktivite geçmişi.
// calls.ts/appointments.ts ile aynı desen: sık filtrelenen alanlar gerçek sütun
// (user_id, stage, meta_lead_id), geri kalanı JSONB 'data'.

import pool from './db';
import { Lead, LeadStage, LeadActivity, LeadActivityType, LEAD_STAGES } from './types';
import { phoneVariants, normalizePhone } from './dncList';

function newLeadId(): string {
  return 'lead_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function newActivityId(): string {
  return 'act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function rowToLead(row: { id: string; stage: string; data: any; created_at: Date; updated_at: Date }): Lead {
  return {
    ...row.data,
    id: row.id,
    stage: row.stage as LeadStage,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getAllLeads(userId: string): Promise<Lead[]> {
  const { rows } = await pool.query(
    `SELECT id, stage, data, created_at, updated_at FROM leads WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(rowToLead);
}

export async function getLead(userId: string, id: string): Promise<Lead | null> {
  const { rows } = await pool.query(
    `SELECT id, stage, data, created_at, updated_at FROM leads WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

export interface CreateLeadInput {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  region?: string | null;
  reference?: string | null;
  source?: Lead['source'];
  metaLeadId?: string | null;
  tags?: string[];
  adData?: Lead['adData'];
  importSource?: string | null;
  importBatchId?: string | null;
}

export async function createLead(userId: string, input: CreateLeadInput): Promise<Lead> {
  const id = newLeadId();
  const data = {
    source: input.source ?? 'MANUAL',
    firstName: input.firstName.trim(),
    lastName: input.lastName?.trim() || null,
    email: input.email?.trim() || null,
    // Tüm aday kaynakları (elle giriş, Meta lead reklamı, CSV) için tek noktada
    // E.164'e normalize et — aramalar da bu biçimde kaydediliyor, böylece arama
    // sonucu doğru adaya eşleşir ve aynı kişi için ikinci bir aday açılmaz.
    phone: normalizePhone(input.phone ?? '') || input.phone?.trim() || null,
    notes: input.notes?.trim() || null,
    region: input.region?.trim() || null,
    reference: input.reference?.trim() || null,
    metaLeadId: input.metaLeadId ?? null,
    tags: input.tags ?? [],
    adData: input.adData ?? null,
    linkedCallId: null,
    importSource: input.importSource?.trim() || null,
    importBatchId: input.importBatchId ?? null,
  };
  const { rows } = await pool.query(
    `INSERT INTO leads (id, user_id, stage, meta_lead_id, data) VALUES ($1, $2, 'NEW', $3, $4)
     RETURNING id, stage, data, created_at, updated_at`,
    [id, userId, input.metaLeadId ?? null, JSON.stringify(data)],
  );
  return rowToLead(rows[0]);
}

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  region?: string | null;
  reference?: string | null;
  tags?: string[];
  whatsappIgnored?: boolean;
}

export async function updateLead(userId: string, id: string, patch: UpdateLeadInput): Promise<Lead | null> {
  const { rows } = await pool.query(
    `UPDATE leads SET data = data || $3::jsonb, updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, stage, data, created_at, updated_at`,
    [id, userId, JSON.stringify(patch)],
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

// Kanban sürükle-bırak / aşama değişimi — aynı sorguda hem stage sütununu hem
// data.stage'i günceller ki rowToLead tutarlı kalsın, ayrıca STAGE_CHANGE aktivitesi loglar.
export async function setLeadStage(userId: string, id: string, stage: LeadStage): Promise<Lead | null> {
  if (!LEAD_STAGES.includes(stage)) throw new Error('Geçersiz aşama: ' + stage);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE leads SET stage = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, stage, data, created_at, updated_at`,
      [id, userId, stage],
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    await client.query(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'STAGE_CHANGE', $4)`,
      [newActivityId(), id, userId, JSON.stringify({ to: stage })],
    );
    await client.query('COMMIT');
    return rowToLead(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── CSV/Excel içe aktarma — kalıcı müşteri veritabanı ─────────────────────
// Toplu Arama'daki CSV yükleme akışıyla aynı satır şekli (bkz. app.js parseContacts),
// ama artık kampanyaya özel geçici bir listeye değil, kalıcı leads tablosuna yazılıyor.

export interface ImportRow {
  name: string;
  phone: string;
  region?: string;
  notes?: string;
  reference?: string;
  leadSource?: string; // serbest metin — "hangi ilan/liste" (Lead.importSource'a gider)
}

export interface ImportConflict {
  row: ImportRow;
  existingLead: Lead;
}

export interface ImportPreview {
  newRows: ImportRow[];
  conflicts: ImportConflict[];
}

function splitName(fullName: string): { firstName: string; lastName: string | null } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || fullName.trim() || 'Bilinmiyor', lastName: parts.slice(1).join(' ') || null };
}

// Hiçbir şey YAZMAZ — sadece hangi satırların yeni, hangilerinin telefon numarası
// zaten veritabanında olan bir adayla çakıştığını hesaplayıp döner. Danışman
// çakışmalar için güncelle/atla/yeni-oluştur seçimini yaptıktan sonra
// commitImportResolutions çağrılır.
export async function previewImportConflicts(userId: string, rows: ImportRow[]): Promise<ImportPreview> {
  const phones = rows.map(r => r.phone.trim()).filter(Boolean);
  if (!phones.length) return { newRows: rows, conflicts: [] };

  // Numaraları tüm yazım biçimleriyle sorgula ve eşleştir. Tam string karşılaştırması
  // yapılırsa, içe aktarılan "+905551234567" ile DB'deki "05551234567" AYNI kişi olduğu
  // halde çakışma sayılmaz — mevcut adayın üzerine yazmak yerine aynı kişi için ikinci
  // bir aday açılır ve danışman CRM'de aynı ismi iki kez görür.
  const lookupVariants = [...new Set(phones.flatMap(p => phoneVariants(p)))];

  const { rows: existingRows } = await pool.query(
    `SELECT id, stage, data, created_at, updated_at FROM leads WHERE user_id = $1 AND data->>'phone' = ANY($2::text[])`,
    [userId, lookupVariants],
  );
  // Her mevcut adayı KENDİ numarasının tüm varyantları altında indeksle, böylece
  // içe aktarılan satır hangi biçimde gelirse gelsin eşleşme bulur.
  const byPhone = new Map<string, Lead>();
  for (const r of existingRows) {
    const lead = rowToLead(r);
    if (!lead.phone) continue;
    for (const variant of phoneVariants(lead.phone)) {
      if (!byPhone.has(variant)) byPhone.set(variant, lead);
    }
  }

  const newRows: ImportRow[] = [];
  const conflicts: ImportConflict[] = [];
  for (const row of rows) {
    const existing = phoneVariants(row.phone).map(v => byPhone.get(v)).find(Boolean);
    if (existing) conflicts.push({ row, existingLead: existing });
    else newRows.push(row);
  }
  return { newRows, conflicts };
}

export interface ImportResolution {
  row: ImportRow;
  existingLeadId?: string;
  action: 'update' | 'skip' | 'create-new';
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  skipped: number;
}

async function insertImportedLead(
  client: import('pg').PoolClient, userId: string, row: ImportRow, importSource: string | null, importBatchId: string,
  tags: string[] = [],
): Promise<void> {
  const { firstName, lastName } = splitName(row.name);
  const data = {
    source: 'CSV_IMPORT', firstName, lastName,
    // Yeni kayıtları E.164'e normalize et — aramalar da bu biçimde kaydediliyor,
    // böylece arama↔aday eşleşmesi varyant aramasına muhtaç kalmadan doğrudan tutar.
    // (phoneVariants eski/karışık biçimli kayıtları yine de yakalar, bu sadece
    // yeni verinin baştan tutarlı olmasını sağlar.)
    email: null, phone: normalizePhone(row.phone) || row.phone.trim(),
    notes: row.notes?.trim() || null, region: row.region?.trim() || null,
    reference: row.reference?.trim() || null,
    metaLeadId: null, tags, adData: null, linkedCallId: null,
    importSource: row.leadSource?.trim() || importSource, importBatchId,
  };
  await client.query(
    `INSERT INTO leads (id, user_id, stage, meta_lead_id, data) VALUES ($1, $2, 'NEW', NULL, $3)`,
    [newLeadId(), userId, JSON.stringify(data)],
  );
}

// Tek transaction — yarım kalmış bir içe aktarma (bazı satırlar yazılıp bazıları
// yazılmadan bir hata oluşması) CRM verisinde tutarsızlığa yol açmasın diye.
// newRows: previewImportConflicts'in "çakışmayan" dediği satırlar, direkt yeni aday olur.
// resolutions: çakışan satırlar için danışmanın seçimi (güncelle/atla/yeni-oluştur).
export async function commitImportResolutions(
  userId: string, newRows: ImportRow[], resolutions: ImportResolution[], importSource: string | null,
  tags: string[] = [],
): Promise<ImportCommitResult> {
  const importBatchId = 'batch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const client = await pool.connect();
  let created = 0, updated = 0, skipped = 0;
  try {
    await client.query('BEGIN');

    for (const row of newRows) {
      if (!row.phone?.trim()) continue;
      await insertImportedLead(client, userId, row, importSource, importBatchId, tags);
      created++;
    }

    for (const res of resolutions) {
      if (res.action === 'skip') { skipped++; continue; }
      if (res.action === 'create-new') {
        if (!res.row.phone?.trim()) { skipped++; continue; }
        await insertImportedLead(client, userId, res.row, importSource, importBatchId, tags);
        created++;
        continue;
      }
      if (res.action === 'update' && res.existingLeadId) {
        const { firstName, lastName } = splitName(res.row.name);
        const patch = {
          firstName, lastName,
          notes: res.row.notes?.trim() || null,
          region: res.row.region?.trim() || null,
          reference: res.row.reference?.trim() || null,
        };
        // Mevcut adayın etiketlerini SİLMİYORUZ — import'un getirdiği etiketleri
        // birleştiriyoruz (danışman elle eklemiş olabileceği etiketler kaybolmasın).
        if (tags.length) {
          const { rows: existing } = await client.query(
            `SELECT data->'tags' AS tags FROM leads WHERE id = $1 AND user_id = $2`,
            [res.existingLeadId, userId],
          );
          const existingTags: string[] = existing[0]?.tags || [];
          (patch as any).tags = [...new Set([...existingTags, ...tags])];
        }
        const { rowCount } = await client.query(
          `UPDATE leads SET data = data || $3::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
          [res.existingLeadId, userId, JSON.stringify(patch)],
        );
        if (rowCount) updated++; else skipped++;
      }
    }

    await client.query('COMMIT');
    return { created, updated, skipped };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Lead → CampaignContact dönüşümü — Toplu Arama'nın kampanya motoruna (campaign.ts)
// beslenebilecek şekle çevirir. leadId burada bilerek tutuluyor (CampaignContact.leadId) —
// arama sonucu geldiğinde telefon-eşleştirmesi yerine doğrudan bu ID ile AYNI lead'e
// yazılabilsin diye (bkz. campaign.ts onCampaignCallEnded/onCampaignSummaryReady).
export function leadsToCampaignContacts(leads: Lead[]): Array<{
  name: string; phone: string; region: string; notes: string; reference: string;
  leadSource?: string; leadId?: string | null;
}> {
  return leads
    .filter(l => !!l.phone)
    .map(l => ({
      name: [l.firstName, l.lastName].filter(Boolean).join(' ') || l.phone || 'Bilinmiyor',
      phone: l.phone as string,
      region: l.region || '',
      notes: l.notes || '',
      reference: l.reference || '',
      leadSource: l.importSource || undefined,
      leadId: l.id,
    }));
}

// ─── Akıllı Plan segment kuralları — leads/lead_activities'e karşı taze SQL ──
// Kasıtlı olarak KAPALI, küçük bir kural seti — genel amaçlı bir sorgu oluşturucu
// DEĞİL. Her plan tetiklendiğinde (bkz. smartPlans.ts tickOnePlan) burası yeniden
// çalıştırılır — cache yok, "yeni giren/artık uymayan leadler" sorunu doğası
// gereği çözülür (üyelik her seferinde taze hesaplanır).
export type SegmentRule =
  | { type: 'STATIC_LIST'; leadIds: string[] }
  | { type: 'NEVER_CONTACTED' }
  | { type: 'STAGE_STALE'; stage: LeadStage; staleDays: number }
  | { type: 'STAGE_EQUALS'; stage: LeadStage }
  | { type: 'SOURCE_EQUALS'; source: Lead['source'] }
  | { type: 'TAG_INCLUDES'; tag: string };

export async function querySegment(userId: string, rule: SegmentRule): Promise<Lead[]> {
  if (rule.type === 'STATIC_LIST') {
    const leads = await Promise.all(rule.leadIds.map(id => getLead(userId, id)));
    return leads.filter((l): l is Lead => !!l);
  }

  if (rule.type === 'NEVER_CONTACTED') {
    const { rows } = await pool.query(
      `SELECT l.id, l.stage, l.data, l.created_at, l.updated_at FROM leads l
       WHERE l.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id AND a.type = 'CALL_COMPLETED')`,
      [userId],
    );
    return rows.map(rowToLead);
  }

  if (rule.type === 'STAGE_STALE') {
    const { rows } = await pool.query(
      `SELECT l.id, l.stage, l.data, l.created_at, l.updated_at FROM leads l
       WHERE l.user_id = $1 AND l.stage = $2
         AND NOT EXISTS (
           SELECT 1 FROM lead_activities a
           WHERE a.lead_id = l.id AND a.created_at > NOW() - ($3 || ' days')::interval
         )`,
      [userId, rule.stage, Math.max(1, Math.round(rule.staleDays || 30))],
    );
    return rows.map(rowToLead);
  }

  if (rule.type === 'STAGE_EQUALS') {
    const { rows } = await pool.query(
      `SELECT id, stage, data, created_at, updated_at FROM leads WHERE user_id = $1 AND stage = $2`,
      [userId, rule.stage],
    );
    return rows.map(rowToLead);
  }

  if (rule.type === 'SOURCE_EQUALS') {
    const { rows } = await pool.query(
      `SELECT id, stage, data, created_at, updated_at FROM leads WHERE user_id = $1 AND data->>'source' = $2`,
      [userId, rule.source],
    );
    return rows.map(rowToLead);
  }

  if (rule.type === 'TAG_INCLUDES') {
    const { rows } = await pool.query(
      `SELECT id, stage, data, created_at, updated_at FROM leads
       WHERE user_id = $1 AND data->'tags' ? $2`,
      [userId, rule.tag],
    );
    return rows.map(rowToLead);
  }

  return [];
}

export async function deleteLead(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM leads WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (rowCount ?? 0) > 0;
}

export async function getLeadActivities(userId: string, leadId: string): Promise<LeadActivity[]> {
  const { rows } = await pool.query(
    `SELECT a.id, a.lead_id, a.type, a.data, a.created_at
     FROM lead_activities a JOIN leads l ON l.id = a.lead_id
     WHERE a.lead_id = $1 AND l.user_id = $2
     ORDER BY a.created_at DESC`,
    [leadId, userId],
  );
  return rows.map(r => ({
    id: r.id, leadId: r.lead_id, type: r.type as LeadActivityType,
    data: r.data, createdAt: r.created_at.toISOString(),
  }));
}

// ─── Arama sonucu → Aday birleşimi (RLM Faz 5) ──────────────────────────────
// ASİMETRİK RİSK — KASITLI (bkz. ai.ts enforceSummaryConsistency ile aynı prensip):
// bir arama sonucu bir adayın aşamasını SADECE İLERİ taşıyabilir, asla geri almaz
// veya LOST'a çekmez — o karar danışmana ait. "Kişiyle konuşuldu" gerçeği bile en
// kötü ihtimalle CONTACTED'a taşır, hiçbir zaman NEW'in altına düşürmez.
const STAGE_RANK: Record<string, number> = { NEW: 0, CONTACTED: 1, QUALIFIED: 2, VIEWING: 3, OFFER: 4, WON: 5, LOST: -1 };

export async function upsertLeadFromCallOutcome(
  userId: string,
  phone: string,
  customerName: string,
  vapiCallId: string,
  randevuAlindi: boolean,
  ilgiSeviyesi: string,
  ozet: string,
): Promise<void> {
  if (!phone?.trim()) return;

  // KASITLI FİLTRE: CRM'i gerçek fırsatla doldur, her soğuk aramayı değil. Randevu
  // alınmışsa veya danışman ilgiyi orta/yüksek işaretlemişse aday oluştur/güncelle;
  // düşük ilgi veya hiç ilgi yoksa (ret, ulaşılamadı, konuşmak istemedi vb.) CRM'e hiç
  // dokunma — ne yeni aday açılır ne mevcut adaya aktivite eklenir. Bu, binlerce
  // aramalık kampanyalarda CRM'in "ilgisiz arandı" kayıtlarıyla boğulmasını önler.
  const qualifies = randevuAlindi || ilgiSeviyesi === 'orta' || ilgiSeviyesi === 'yüksek';
  if (!qualifies) return;

  const candidateStage: LeadStage = randevuAlindi ? 'QUALIFIED' : 'CONTACTED';

  // Numaranın tüm yazım biçimleriyle ara. Aramalar E.164 ("+90555…") kaydediliyor
  // ama adaylar CSV/elle girişten gelirken ham ("0555…") olabiliyor; tek formatla
  // eşleştirirsek mevcut aday BULUNAMAZ ve aynı kişi için CRM'de ikinci bir aday
  // açılır (danışman aynı kişiyi iki kez görür).
  const { rows } = await pool.query(
    `SELECT id, stage FROM leads WHERE user_id = $1 AND data->>'phone' = ANY($2::text[]) ORDER BY updated_at DESC LIMIT 1`,
    [userId, phoneVariants(phone)],
  );

  let leadId: string;
  if (rows[0]) {
    leadId = rows[0].id;
    const currentRank = STAGE_RANK[rows[0].stage] ?? 0;
    const candidateRank = STAGE_RANK[candidateStage];
    if (candidateRank > currentRank) {
      await pool.query(
        `UPDATE leads SET stage = $3, data = data || jsonb_build_object('linkedCallId', $4::text), updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [leadId, userId, candidateStage, vapiCallId],
      );
    } else {
      await pool.query(
        `UPDATE leads SET data = data || jsonb_build_object('linkedCallId', $3::text), updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [leadId, userId, vapiCallId],
      );
    }
  } else {
    const parts = customerName.trim().split(/\s+/);
    const created = await createLead(userId, {
      firstName: parts[0] || customerName || 'Bilinmiyor',
      lastName: parts.slice(1).join(' ') || null,
      phone: phone.trim(),
      source: 'CALL_CAMPAIGN',
    });
    leadId = created.id;
    await pool.query(`UPDATE leads SET stage = $2 WHERE id = $1`, [leadId, candidateStage]);
    await pool.query(
      `UPDATE leads SET data = data || jsonb_build_object('linkedCallId', $2::text) WHERE id = $1`,
      [leadId, vapiCallId],
    );
  }

  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'CALL_COMPLETED', $4)`,
    [newActivityId(), leadId, userId, JSON.stringify({ vapiCallId, randevuAlindi, ilgiSeviyesi, ozet })],
  );
}

// upsertLeadFromCallOutcome'un ID-bazlı kardeşi — arama, müşteri veritabanından
// (leads) seçilerek kampanyaya eklenmiş bir kişiye yapıldıysa (bkz. CampaignContact.leadId,
// campaign.ts onCampaignSummaryReady) telefon numarasıyla yeniden eşleştirmeye/yeni
// bir lead yaratmaya GEREK YOK — sonuç doğrudan AYNI lead'e, aynı asimetrik-risk
// (sadece ileri, asla geri) kuralıyla yazılır.
export async function applyCallOutcomeToLeadById(
  userId: string, leadId: string, vapiCallId: string,
  randevuAlindi: boolean, ilgiSeviyesi: string, ozet: string,
): Promise<void> {
  const qualifies = randevuAlindi || ilgiSeviyesi === 'orta' || ilgiSeviyesi === 'yüksek';
  if (!qualifies) return;

  const candidateStage: LeadStage = randevuAlindi ? 'QUALIFIED' : 'CONTACTED';
  const { rows } = await pool.query(`SELECT stage FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
  if (!rows[0]) return; // lead silinmiş olabilir — sessizce atla

  const currentRank = STAGE_RANK[rows[0].stage] ?? 0;
  if (STAGE_RANK[candidateStage] > currentRank) {
    await pool.query(
      `UPDATE leads SET stage = $3, data = data || jsonb_build_object('linkedCallId', $4::text), updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [leadId, userId, candidateStage, vapiCallId],
    );
  } else {
    await pool.query(
      `UPDATE leads SET data = data || jsonb_build_object('linkedCallId', $3::text), updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [leadId, userId, vapiCallId],
    );
  }

  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'CALL_COMPLETED', $4)`,
    [newActivityId(), leadId, userId, JSON.stringify({ vapiCallId, randevuAlindi, ilgiSeviyesi, ozet })],
  );
}

// ─── WhatsApp yazışması → Aday aşaması (aramadakiyle aynı asimetrik-risk ilkesi) ────
// Farkı: WhatsApp mesajı geldiğinde aday zaten var (recordChannelMessage mesajı
// saklamak için hemen oluşturur — bir mesaj gövdesinin nereye ait olacağı DB şeması
// gereği bilinmeden depolanamaz). Bu yüzden burada "aday oluştur mu" sorusu yok,
// sadece "bu yazışma aşamayı İLERİ taşımaya değer mi" sorusu var — düşük/hiç ilgi
// yazışmaları aday NEW'de kalır (Kanban'da zaten "henüz nitelendirilmedi" anlamına
// gelir), CONTACTED/QUALIFIED'a SADECE gerçek ilgi/randevu ile yükselir.
export async function applyWhatsappAnalysisToLead(
  userId: string, leadId: string, randevuAlindi: boolean, ilgiSeviyesi: string, ozet: string,
): Promise<void> {
  const qualifies = randevuAlindi || ilgiSeviyesi === 'orta' || ilgiSeviyesi === 'yüksek';
  const candidateStage: LeadStage = randevuAlindi ? 'QUALIFIED' : 'CONTACTED';

  if (qualifies) {
    const { rows } = await pool.query(`SELECT stage FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
    if (rows[0]) {
      const currentRank = STAGE_RANK[rows[0].stage] ?? 0;
      if (STAGE_RANK[candidateStage] > currentRank) {
        await pool.query(
          `UPDATE leads SET stage = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
          [leadId, userId, candidateStage],
        );
      }
    }
  }

  // qualifies=false olsa bile HER ZAMAN loglanır — bu kayıt aynı zamanda "en son ne zaman
  // analiz edildi" damgası olarak kullanılır (bkz. whatsappCampaigns.ts recordChannelMessage
  // debounce kontrolü), her gelen mesajda tekrar tekrar Anthropic'e gitmemek için.
  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'WHATSAPP_ANALYZED', $4)`,
    [newActivityId(), leadId, userId, JSON.stringify({ randevuAlindi, ilgiSeviyesi, ozet, qualifies })],
  );
}

// leadId'ye ait TÜM WhatsApp thread'ini (kanal fark etmeksizin) Anthropic'e gönderip
// analiz sonucunu applyWhatsappAnalysisToLead ile uygular. Anthropic key tanımlı
// değilse sessizce atlar — mesaj kaydı zaten yapılmış olur, sadece aşama yükseltmesi
// (ve dolayısıyla CRM'e "gerçek fırsat" olarak yansıma) gerçekleşmez.
export async function analyzeWhatsappThreadForLead(userId: string, leadId: string, customerName: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT direction, body FROM whatsapp_messages WHERE lead_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [leadId, userId],
  );
  if (!rows.length) return;

  const { getUserAnthropicKey } = await import('./users');
  const apiKey = await getUserAnthropicKey(userId);
  if (!apiKey) return;

  const { analyzeWhatsappThread } = await import('./ai');
  const { analysis } = await analyzeWhatsappThread(
    apiKey, customerName,
    rows.map(r => ({ direction: r.direction as 'IN' | 'OUT', body: r.body as string })),
  );
  await applyWhatsappAnalysisToLead(userId, leadId, analysis.randevu_alindi, analysis.ilgi_seviyesi, analysis.ozet);
}

export async function addLeadActivity(
  userId: string, leadId: string, type: LeadActivityType, data: Record<string, unknown>,
): Promise<LeadActivity | null> {
  // Sahiplik kontrolü — leads.user_id eşleşmezse hiçbir şey eklenmez.
  const owned = await pool.query(`SELECT 1 FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
  if (!owned.rows[0]) return null;
  const id = newActivityId();
  const { rows } = await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, lead_id, type, data, created_at`,
    [id, leadId, userId, type, JSON.stringify(data)],
  );
  return { id: rows[0].id, leadId: rows[0].lead_id, type: rows[0].type, data: rows[0].data, createdAt: rows[0].created_at.toISOString() };
}
