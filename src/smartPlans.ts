// PropCall AI — Akıllı Plan: belirli gün/saat penceresinde, günlük arama tavanıyla
// otomatik kampanya açıp kapatan zamanlayıcı. KENDİ DİALER'INI YAZMAZ — mevcut
// campaign.ts motorunu (kuyruk, eşzamanlılık, arama-saatleri, kredi duraklatma,
// retry — hepsi zaten çalışıyor) olduğu gibi kullanır; sadece doğru zamanda
// campaignLoad/campaignStart/campaignPause/campaignResume'u çağıran ince bir
// orkestrasyon katmanıdır (bkz. metaLeads.ts'in kendi setInterval job'unu
// barındırma deseniyle aynı yapı).
//
// Faz 4: segment_rule artık leads.ts'teki querySegment() kural motoruna (5 sabit
// tip: STATIC_LIST, NEVER_CONTACTED, STAGE_STALE, STAGE_EQUALS, SOURCE_EQUALS,
// TAG_INCLUDES) devrediliyor — her plan tetiklendiğinde TAZE sorgulanır, cache
// yok. Zamanlama/pencere/idempotency mantığı (Faz 3'te doğrulandı) değişmedi.

import pool from './db';
import {
  campaignLoad, campaignStart, campaignPause, campaignResume,
  isWithinCallingHours, currentIstanbulDateParts, broadcastToUser,
} from './campaign';
import { getCampaign } from './campaigns';
import { toClientError } from './campaignErrors';
import type { SegmentRule } from './leads';

export type { SegmentRule } from './leads';
export type SmartPlanStatus = 'active' | 'paused' | 'archived';

export interface SmartPlan {
  id: string;
  userId: string;
  name: string;
  status: SmartPlanStatus;
  scenarioId: string | null;
  scenarioName: string | null;
  maxConcurrent: number;
  dailyCallCap: number;
  daysOfWeek: number[];
  windowStartHour: number;
  windowEndHour: number;
  segmentRule: SegmentRule;
  lastRunDate: string | null;
  activeCampaignId: string | null;
  createdAt: string;
  updatedAt: string;
}

function newPlanId(): string {
  return 'plan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function rowToPlan(r: any): SmartPlan {
  return {
    id: r.id, userId: r.user_id, name: r.name, status: r.status,
    scenarioId: r.scenario_id, scenarioName: r.scenario_name,
    maxConcurrent: r.max_concurrent, dailyCallCap: r.daily_call_cap,
    daysOfWeek: r.days_of_week || [], windowStartHour: r.window_start_hour, windowEndHour: r.window_end_hour,
    segmentRule: r.segment_rule,
    lastRunDate: r.last_run_date ? (r.last_run_date.toISOString?.() ?? String(r.last_run_date)).slice(0, 10) : null,
    activeCampaignId: r.active_campaign_id,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}

export interface CreateSmartPlanInput {
  name: string;
  scenarioId?: string | null;
  scenarioName?: string | null;
  maxConcurrent?: number;
  dailyCallCap?: number;
  daysOfWeek: number[];
  windowStartHour: number;
  windowEndHour: number;
  segmentRule: SegmentRule;
}

export async function listSmartPlans(userId: string): Promise<SmartPlan[]> {
  const { rows } = await pool.query(
    `SELECT * FROM smart_plans WHERE user_id = $1 ORDER BY created_at DESC`, [userId],
  );
  return rows.map(rowToPlan);
}

export async function createSmartPlan(userId: string, input: CreateSmartPlanInput): Promise<SmartPlan> {
  const id = newPlanId();
  const { rows } = await pool.query(
    `INSERT INTO smart_plans
       (id, user_id, name, scenario_id, scenario_name, max_concurrent, daily_call_cap,
        days_of_week, window_start_hour, window_end_hour, segment_rule)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      id, userId, input.name.trim(), input.scenarioId || null, input.scenarioName || null,
      input.maxConcurrent || 1, input.dailyCallCap || 0,
      input.daysOfWeek, input.windowStartHour, input.windowEndHour,
      JSON.stringify(input.segmentRule),
    ],
  );
  return rowToPlan(rows[0]);
}

export async function updateSmartPlanStatus(userId: string, id: string, status: SmartPlanStatus): Promise<SmartPlan | null> {
  const { rows } = await pool.query(
    `UPDATE smart_plans SET status = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, status],
  );
  return rows[0] ? rowToPlan(rows[0]) : null;
}

export async function deleteSmartPlan(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM smart_plans WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (rowCount ?? 0) > 0;
}

// Segment kuralını gerçek kampanya kişisi listesine çevirir. Faz 3'te tek kural
// tipi var (STATIC_LIST) — Faz 4'te buraya NEVER_CONTACTED/STAGE_STALE gibi
// leads tablosuna karşı taze SQL sorgusu çalıştıran dallar eklenecek.
async function resolveSegment(userId: string, rule: SegmentRule) {
  const { querySegment, leadsToCampaignContacts } = await import('./leads');
  const leads = await querySegment(userId, rule);
  return leadsToCampaignContacts(leads);
}

async function markRanToday(planId: string, ymd: string, activeCampaignId: string | null): Promise<void> {
  await pool.query(
    `UPDATE smart_plans SET last_run_date = $2, active_campaign_id = $3, updated_at = NOW() WHERE id = $1`,
    [planId, ymd, activeCampaignId],
  );
}

// Tek bir planı değerlendirir — gün/saat penceresi uygun mu, bugün için zaten
// bir çalışma başlatıldı mı, pencere kapanınca devam eden kampanyayı duraklatma/
// tekrar açma. Tüm gerçek arama mantığı (kuyruk, eşzamanlılık, kredi, retry)
// campaign.ts'in kendi tick döngüsünde zaten çalışıyor — burası SADECE
// campaignLoad/Start/Pause/Resume'u doğru zamanda tetikler.
async function tickOnePlan(plan: SmartPlan): Promise<void> {
  const { dayOfWeek, ymd } = currentIstanbulDateParts();
  const dayMatches = plan.daysOfWeek.includes(dayOfWeek);
  const inWindow = dayMatches && isWithinCallingHours(plan.windowStartHour, plan.windowEndHour);

  // Bugün için zaten bir kampanya açılmışsa — devam eden/duraklatılmış işi yönet.
  if (plan.activeCampaignId) {
    const camp = await getCampaign(plan.userId, plan.activeCampaignId);
    if (!camp) { await markRanToday(plan.id, plan.lastRunDate || ymd, null); return; }

    const stillRunning = camp.status === 'running' || camp.status === 'paused';
    if (!stillRunning) {
      // Kampanya kendi kendine bitmiş (completed/stopped) — bugün için iş tamam.
      if (plan.lastRunDate !== ymd) await markRanToday(plan.id, ymd, plan.activeCampaignId);
      return;
    }

    if (!inWindow && camp.status === 'running') {
      // Pencere kapandı ama kampanya hâlâ çalışıyor — devam eden aramalar kesilmez,
      // sadece yeni arama başlatma durdurulur (campaign.ts'teki calling-hours
      // felsefesiyle aynı, bkz. dosya başı yorumu).
      await campaignPause(plan.userId, plan.activeCampaignId).catch(err =>
        console.error(`[SmartPlan] "${plan.name}" duraklatma hatası:`, err));
      return;
    }
    if (inWindow && camp.status === 'paused') {
      await campaignResume(plan.userId, plan.activeCampaignId).catch(err =>
        console.error(`[SmartPlan] "${plan.name}" devam ettirme hatası:`, err));
      return;
    }
    return; // running + inWindow, veya paused + !inWindow — yapacak bir şey yok
  }

  // Henüz bugün için bir kampanya açılmamış — pencere açıksa ve bugün daha önce
  // çalışmadıysa yeni bir günlük kampanya başlat.
  if (!inWindow || plan.lastRunDate === ymd) return;

  const contacts = await resolveSegment(plan.userId, plan.segmentRule);
  if (!contacts.length) {
    console.log(`[SmartPlan] "${plan.name}" — bugün hedef kalmadı, kampanya açılmadı.`);
    await markRanToday(plan.id, ymd, null);
    // Sessizlik "çalışıyor ama kimse yok" ile "hiç çalışmadı"yı ayırt edilemez kılıyordu —
    // danışman Akıllı Plan sekmesine bakmadan bunu asla öğrenemezdi (bkz. calling-hours
    // banner'ının aksine, bu olayın hiç canlı bildirimi yoktu).
    broadcastToUser(plan.userId, 'smart-plan-empty', { planName: plan.name });
    return;
  }

  try {
    const campaignId = await campaignLoad(
      plan.userId, contacts, plan.maxConcurrent, plan.scenarioId || undefined,
      0, plan.dailyCallCap || 0, 0, `${plan.name} — ${ymd}`,
      undefined, undefined, plan.id,
    );
    await campaignStart(plan.userId, campaignId);
    await markRanToday(plan.id, ymd, campaignId);
    console.log(`[SmartPlan] "${plan.name}" — ${contacts.length} kişilik günlük kampanya başlatıldı (${campaignId}).`);
    // "campaign-update" zaten campaignStart içinde yayınlanıyor ama client'ta SADECE
    // o an odaklanılan kampanya için işleniyor (bkz. app.js) — danışman ekrana
    // bakmıyorsa bu sessizce kaybolur. Ayrı, odak-bağımsız olmayan bir olay lazım.
    broadcastToUser(plan.userId, 'smart-plan-fired', { planName: plan.name, campaignId, contactCount: contacts.length });
  } catch (err) {
    console.error(`[SmartPlan] "${plan.name}" başlatma hatası:`, err);
    // Bugün için tekrar tekrar denemesin — hata devam ediyorsa (örn. Vapi kimlik
    // bilgisi eksik) her tick'te aynı hatayı üretmek yerine yarına kadar bekler.
    await markRanToday(plan.id, ymd, null);
    broadcastToUser(plan.userId, 'smart-plan-error', { planName: plan.name, error: toClientError(err) });
  }
}

async function tickSmartPlans(): Promise<void> {
  const { rows } = await pool.query(`SELECT * FROM smart_plans WHERE status = 'active'`);
  const plans = rows.map(rowToPlan);
  await Promise.allSettled(plans.map(tickOnePlan));
}

export function startSmartPlanScheduler(): void {
  setInterval(() => {
    tickSmartPlans().catch(err => console.error('[SmartPlan] Tick hatası:', err));
  }, 60_000).unref();
  console.log('[SmartPlan] Zamanlayıcı başlatıldı (60sn aralıklı)');
}
