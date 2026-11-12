// PropCall AI / RLM — Adaylar (Leads) CRUD + Kanban aşama geçişleri + aktivite geçmişi.
// calls.ts/appointments.ts ile aynı desen: sık filtrelenen alanlar gerçek sütun
// (user_id, stage, meta_lead_id), geri kalanı JSONB 'data'.

import pool from './db';
import {
  Lead, LeadStage, LeadActivity, LeadActivityType, LEAD_STAGES, normalizeLeadStage,
  DealType, AuthorityType, LostReason, DEAL_TYPES, AUTHORITY_TYPES, LOST_REASONS,
} from './types';
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
    // Göç UPDATE'i çalışmadan önce okunmuş eski bir satır bile istemciye yeni kodla gider.
    stage: normalizeLeadStage(row.stage),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ── Fırsat alanı doğrulama — API'den gelen ham değerleri temizler/sınırlar ──
// undefined = "bu alana dokunma", null = "temizle". Geçersiz enum → hata (400'e çevrilir).
export interface DealFieldsInput {
  dealType?: DealType | null;
  propertyType?: string | null;
  propertyLocation?: string | null;
  propertyM2?: number | string | null;
  priceExpectation?: number | string | null;
  authority?: AuthorityType | null;
}

function cleanNumber(v: number | string | null | undefined, label: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  // "5.250.000", "5,250,000", "120,5", "1.200.000 TL" hepsi kabul: tek ayraç + 1-2 hane
  // ondalık sayılır, gerisi binlik ayracı olarak atılır.
  let n: number;
  if (typeof v === 'number') n = v;
  else {
    const s = String(v).replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) throw new Error(`${label} sayı olmalı`);
    const dec = s.match(/^(\d+)[.,](\d{1,2})$/);
    n = dec ? Number(dec[1] + '.' + dec[2]) : Number(s.replace(/[.,]/g, ''));
  }
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} sayı olmalı`);
  return Math.round(n);
}

export function sanitizeDealFields(input: DealFieldsInput): Partial<Lead> {
  const out: Partial<Lead> = {};
  if (input.dealType !== undefined) {
    if (input.dealType !== null && !DEAL_TYPES.includes(input.dealType)) throw new Error('Geçersiz fırsat tipi');
    out.dealType = input.dealType;
  }
  if (input.authority !== undefined) {
    if (input.authority !== null && !AUTHORITY_TYPES.includes(input.authority)) throw new Error('Geçersiz yetki durumu');
    out.authority = input.authority;
  }
  if (input.propertyType !== undefined) out.propertyType = input.propertyType?.toString().trim().slice(0, 120) || null;
  if (input.propertyLocation !== undefined) out.propertyLocation = input.propertyLocation?.toString().trim().slice(0, 160) || null;
  const m2 = cleanNumber(input.propertyM2, 'Metrekare');
  if (m2 !== undefined) out.propertyM2 = m2;
  const price = cleanNumber(input.priceExpectation, 'Fiyat beklentisi');
  if (price !== undefined) out.priceExpectation = price;
  return out;
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
  deal?: DealFieldsInput;
}

export async function createLead(userId: string, input: CreateLeadInput): Promise<Lead> {
  const id = newLeadId();
  const deal = sanitizeDealFields(input.deal ?? {});
  const data = {
    dealType: null, propertyType: null, propertyLocation: null, propertyM2: null, priceExpectation: null,
    authority: null, lostReason: null, lostNote: null,
    ...deal,
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
  deal?: DealFieldsInput;
}

export async function updateLead(userId: string, id: string, patch: UpdateLeadInput): Promise<Lead | null> {
  const { deal, ...rest } = patch;
  const merged: Record<string, unknown> = { ...rest, ...sanitizeDealFields(deal ?? {}) };
  // undefined alanlar JSON.stringify'da zaten düşer; data || ile sadece verilenler değişir.
  const { rows } = await pool.query(
    `UPDATE leads SET data = data || $3::jsonb, updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, stage, data, created_at, updated_at`,
    [id, userId, JSON.stringify(merged)],
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

export interface StageChangeOptions {
  lostReason?: LostReason | null;
  lostNote?: string | null;
}

// Kanban sürükle-bırak / aşama değişimi — STAGE_CHANGE aktivitesi loglar.
// LOST'a geçiş kayıp nedeni ister (huni raporu için); LOST dışına çıkınca neden temizlenir
// (geçmişi aktivite kaydı zaten tutar).
export async function setLeadStage(
  userId: string, id: string, stage: LeadStage, opts: StageChangeOptions = {},
): Promise<Lead | null> {
  if (!LEAD_STAGES.includes(stage)) throw new Error('Geçersiz aşama: ' + stage);
  let dataPatch: Record<string, unknown>;
  if (stage === 'LOST') {
    if (!opts.lostReason || !LOST_REASONS.includes(opts.lostReason)) throw new Error('Kayıp nedeni zorunlu');
    dataPatch = { lostReason: opts.lostReason, lostNote: opts.lostNote?.toString().trim().slice(0, 500) || null };
  } else {
    dataPatch = { lostReason: null, lostNote: null };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(`SELECT stage FROM leads WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!before[0]) { await client.query('ROLLBACK'); return null; }
    const { rows } = await client.query(
      `UPDATE leads SET stage = $3, data = data || $4::jsonb, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, stage, data, created_at, updated_at`,
      [id, userId, stage, JSON.stringify(dataPatch)],
    );
    await client.query(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'STAGE_CHANGE', $4)`,
      [newActivityId(), id, userId, JSON.stringify({
        from: normalizeLeadStage(before[0].stage), to: stage,
        ...(stage === 'LOST' ? { lostReason: dataPatch.lostReason, lostNote: dataPatch.lostNote } : {}),
      })],
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

  // Eski akıllı planların kuralı hâlâ QUALIFIED/VIEWING/OFFER diyebilir — yeni koda çevir.
  if (rule.type === 'STAGE_STALE') {
    const { rows } = await pool.query(
      `SELECT l.id, l.stage, l.data, l.created_at, l.updated_at FROM leads l
       WHERE l.user_id = $1 AND l.stage = $2
         AND NOT EXISTS (
           SELECT 1 FROM lead_activities a
           WHERE a.lead_id = l.id AND a.created_at > NOW() - ($3 || ' days')::interval
         )`,
      [userId, normalizeLeadStage(rule.stage), Math.max(1, Math.round(rule.staleDays || 30))],
    );
    return rows.map(rowToLead);
  }

  if (rule.type === 'STAGE_EQUALS') {
    const { rows } = await pool.query(
      `SELECT id, stage, data, created_at, updated_at FROM leads WHERE user_id = $1 AND stage = $2`,
      [userId, normalizeLeadStage(rule.stage)],
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
const STAGE_RANK: Record<LeadStage, number> = { NEW: 0, CONTACTED: 1, MEETING: 2, AGREEMENT: 3, WON: 4, LOST: -1 };
const rankOf = (raw: string): number => STAGE_RANK[normalizeLeadStage(raw)] ?? 0;

// Arama özetindeki mülk tipini ("3+1 daire", "arsa"…) fırsata yazar — SADECE alan
// boşsa; danışmanın elle girdiği bilgi AI'nın yan bilgisiyle ezilmez.
function propertyTypePatch(mulkTipi: string | null | undefined): Record<string, unknown> {
  const v = mulkTipi?.toString().trim();
  return v ? { propertyType: v.slice(0, 120) } : {};
}
async function fillPropertyTypeIfEmpty(leadId: string, mulkTipi: string | null | undefined): Promise<void> {
  const patch = propertyTypePatch(mulkTipi);
  if (!Object.keys(patch).length) return;
  await pool.query(
    `UPDATE leads SET data = data || $2::jsonb WHERE id = $1 AND COALESCE(data->>'propertyType','') = ''`,
    [leadId, JSON.stringify(patch)],
  );
}

export async function upsertLeadFromCallOutcome(
  userId: string,
  phone: string,
  customerName: string,
  vapiCallId: string,
  randevuAlindi: boolean,
  ilgiSeviyesi: string,
  ozet: string,
  mulkTipi: string | null = null,
): Promise<void> {
  if (!phone?.trim()) return;

  // KASITLI FİLTRE: CRM'i gerçek fırsatla doldur, her soğuk aramayı değil. Randevu
  // alınmışsa veya danışman ilgiyi orta/yüksek işaretlemişse aday oluştur/güncelle;
  // düşük ilgi veya hiç ilgi yoksa (ret, ulaşılamadı, konuşmak istemedi vb.) CRM'e hiç
  // dokunma — ne yeni aday açılır ne mevcut adaya aktivite eklenir. Bu, binlerce
  // aramalık kampanyalarda CRM'in "ilgisiz arandı" kayıtlarıyla boğulmasını önler.
  const qualifies = randevuAlindi || ilgiSeviyesi === 'orta' || ilgiSeviyesi === 'yüksek';
  if (!qualifies) return;

  const candidateStage: LeadStage = randevuAlindi ? 'MEETING' : 'CONTACTED';

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
    const currentRank = rankOf(rows[0].stage);
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
  await fillPropertyTypeIfEmpty(leadId, mulkTipi);

  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'CALL_COMPLETED', $4)`,
    [newActivityId(), leadId, userId, JSON.stringify({ vapiCallId, randevuAlindi, ilgiSeviyesi, ozet })],
  );
  await scheduleFollowupTask(userId, leadId, vapiCallId, randevuAlindi, ozet);
}

// Arama sonucu → otomatik "sonraki adım" (CRM Faz 1, bkz. src/tasks.ts). Randevu
// alındıysa ertesi sabah bir randevu görevi (AI saat/yer bilmez; danışman teyit edip
// düzeltir), sadece ilgi varsa 2 gün sonra "geri ara". Aynı kişiye açık görev varsa
// ikinci açılmaz (kampanya tekrar araması Bugün listesini şişirmesin).
async function scheduleFollowupTask(
  userId: string, leadId: string, vapiCallId: string, randevuAlindi: boolean, ozet: string,
): Promise<void> {
  try {
    const { ensureOpenTaskForLead, istanbulAt } = await import('./tasks');
    if (randevuAlindi) {
      await ensureOpenTaskForLead(userId, leadId, {
        title: 'Randevuyu teyit et', kind: 'meeting', dueAt: istanbulAt(1, 10), source: 'ai_call', vapiCallId, note: ozet,
      });
    } else {
      await ensureOpenTaskForLead(userId, leadId, {
        title: 'Geri ara', kind: 'call', dueAt: istanbulAt(2, 10), source: 'ai_call', vapiCallId, note: ozet,
      });
    }
  } catch (err) {
    console.error('[Tasks] Arama sonucu → görev oluşturulamadı:', err);
  }
}

// upsertLeadFromCallOutcome'un ID-bazlı kardeşi — arama, müşteri veritabanından
// (leads) seçilerek kampanyaya eklenmiş bir kişiye yapıldıysa (bkz. CampaignContact.leadId,
// campaign.ts onCampaignSummaryReady) telefon numarasıyla yeniden eşleştirmeye/yeni
// bir lead yaratmaya GEREK YOK — sonuç doğrudan AYNI lead'e, aynı asimetrik-risk
// (sadece ileri, asla geri) kuralıyla yazılır.
export async function applyCallOutcomeToLeadById(
  userId: string, leadId: string, vapiCallId: string,
  randevuAlindi: boolean, ilgiSeviyesi: string, ozet: string, mulkTipi: string | null = null,
): Promise<void> {
  const qualifies = randevuAlindi || ilgiSeviyesi === 'orta' || ilgiSeviyesi === 'yüksek';
  if (!qualifies) return;

  const candidateStage: LeadStage = randevuAlindi ? 'MEETING' : 'CONTACTED';
  const { rows } = await pool.query(`SELECT stage FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
  if (!rows[0]) return; // lead silinmiş olabilir — sessizce atla

  const currentRank = rankOf(rows[0].stage);
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
  await fillPropertyTypeIfEmpty(leadId, mulkTipi);

  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'CALL_COMPLETED', $4)`,
    [newActivityId(), leadId, userId, JSON.stringify({ vapiCallId, randevuAlindi, ilgiSeviyesi, ozet })],
  );
  await scheduleFollowupTask(userId, leadId, vapiCallId, randevuAlindi, ozet);
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
  const candidateStage: LeadStage = randevuAlindi ? 'MEETING' : 'CONTACTED';

  if (qualifies) {
    const { rows } = await pool.query(`SELECT stage FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
    if (rows[0]) {
      const currentRank = rankOf(rows[0].stage);
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

// ─── Kişi kartı zaman çizelgesi (CRM Faz 3) ────────────────────────────────
// Tek kronolojik akış: aşama değişimleri + notlar (lead_activities), gerçek aramalar
// (calls, numara varyantlarıyla), WhatsApp mesajları, görevler (açık + tamamlanan) ve
// kaydın oluşturulması. Dört sorgu paralel; birleştirme/sıralama burada.
export interface TimelineEvent {
  id: string;
  type: 'created' | 'stage' | 'note' | 'call' | 'whatsapp' | 'task' | 'activity';
  at: string;
  title: string;
  detail: string | null;
  meta: Record<string, unknown>;
}

export async function getLeadTimeline(userId: string, leadId: string, limit = 200): Promise<TimelineEvent[] | null> {
  const lead = await getLead(userId, leadId);
  if (!lead) return null;
  const variants = lead.phone ? phoneVariants(lead.phone) : [];
  const [acts, calls, msgs, tasks] = await Promise.all([
    pool.query(`SELECT id, type, data, created_at FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT $2`, [leadId, limit]),
    variants.length
      ? pool.query(
        `SELECT vapi_call_id, status, start_time, created_at, data->'summary' AS summary, data->>'duration' AS duration
         FROM calls WHERE user_id = $1 AND data->>'customerPhone' = ANY($2::text[]) AND COALESCE(is_practice, false) = false
         ORDER BY COALESCE(start_time, created_at) DESC LIMIT $3`, [userId, variants, limit])
      : Promise.resolve({ rows: [] as any[] }),
    pool.query(`SELECT id, direction, body, status, created_at FROM whatsapp_messages WHERE lead_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`, [leadId, userId, limit]),
    pool.query(`SELECT id, title, kind, due_at, status, done_at, created_at, source FROM tasks WHERE lead_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`, [leadId, userId, limit]),
  ]);

  const events: TimelineEvent[] = [];
  events.push({ id: 'created', type: 'created', at: lead.createdAt, title: 'Kişi oluşturuldu', detail: null, meta: { source: lead.source } });
  for (const a of acts.rows) {
    const at = new Date(a.created_at).toISOString();
    if (a.type === 'STAGE_CHANGE') events.push({ id: a.id, type: 'stage', at, title: 'Aşama değişti', detail: null, meta: a.data });
    else if (a.type === 'NOTE') events.push({ id: a.id, type: 'note', at, title: 'Not', detail: a.data?.note ?? null, meta: {} });
    else if (a.type === 'CALL_COMPLETED') continue; // gerçek arama kaydı aşağıda calls'tan geliyor
    else events.push({ id: a.id, type: 'activity', at, title: a.type, detail: a.data?.ozet ?? null, meta: a.data });
  }
  for (const c of calls.rows) {
    const s = c.summary || null;
    events.push({
      id: c.vapi_call_id, type: 'call', at: new Date(c.start_time || c.created_at).toISOString(),
      title: s ? (s.randevu_alindi ? 'Arama — randevu alındı' : `Arama — ilgi ${s.ilgi_seviyesi || '?'}`) : `Arama (${c.status || 'bilinmiyor'})`,
      detail: s?.ozet ?? null,
      meta: { vapiCallId: c.vapi_call_id, status: c.status, duration: c.duration ? Number(c.duration) : null, randevuAlindi: !!s?.randevu_alindi, ilgiSeviyesi: s?.ilgi_seviyesi ?? null },
    });
  }
  for (const m of msgs.rows) {
    events.push({
      id: m.id, type: 'whatsapp', at: new Date(m.created_at).toISOString(),
      title: m.direction === 'IN' ? 'WhatsApp — geldi' : 'WhatsApp — gönderildi',
      detail: m.body, meta: { direction: m.direction, status: m.status },
    });
  }
  for (const t of tasks.rows) {
    events.push({
      id: t.id, type: 'task', at: new Date(t.status === 'done' && t.done_at ? t.done_at : t.created_at).toISOString(),
      title: t.status === 'done' ? 'Görev tamamlandı' : 'Görev açıldı',
      detail: t.title,
      meta: { taskId: t.id, kind: t.kind, status: t.status, dueAt: new Date(t.due_at).toISOString(), source: t.source },
    });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, limit);
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
