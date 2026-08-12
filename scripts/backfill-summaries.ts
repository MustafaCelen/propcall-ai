// Tek seferlik backfill: belirli bir tarih aralığındaki aramaların özetini
// yeni dinamik prompt mantığıyla (resolveScenarioPromptForSummary) yeniden üretir.
//
// Kullanım: npx ts-node scripts/backfill-summaries.ts
//
// NOT: Sadece transcript'i olan aramalar işlenir. Anthropic'i yormamak için
// eş zamanlılık 3 ile sınırlı.

import dotenv from 'dotenv';
dotenv.config();

import pool from '../src/db';
import { readCall, saveCallSummary } from '../src/calls';
import { generateCallSummary } from '../src/ai';
import { getScenario } from '../src/scenarios';
import { getAssistantSystemPrompt } from '../src/vapi';
import { CallRecord } from '../src/types';

// ─── Kapsam: sadece son 2 gün (KW Büyüme kampanyası) ──────────────────────
const SINCE_ISO = '2026-08-11T00:00:00.000Z';

async function resolveScenarioPromptForSummary(record: CallRecord): Promise<string | null> {
  if (record.scenarioId) {
    try {
      const scenario = await getScenario(record.scenarioId);
      if (scenario?.systemPrompt) return scenario.systemPrompt;
    } catch (err) {
      console.warn(`[Backfill] Senaryo promptu alınamadı (${record.vapiCallId}):`, err);
    }
  }
  try {
    const { systemPrompt } = await getAssistantSystemPrompt();
    return systemPrompt || null;
  } catch (err) {
    console.warn(`[Backfill] Vapi canlı prompt alınamadı (${record.vapiCallId}):`, err);
    return null;
  }
}

// Basit eş zamanlılık sınırlayıcı — p-limit ESM-only olduğu için (proje CJS) kendimiz yazdık
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  async function next(): Promise<void> {
    const i = idx++;
    if (i >= items.length) return;
    await worker(items[i]);
    await next();
  }
  await Promise.all(Array.from({ length: limit }, () => next()));
}

async function main() {
  const { rows } = await pool.query<{ vapi_call_id: string }>(
    `SELECT vapi_call_id FROM calls
     WHERE start_time >= $1
       AND jsonb_array_length(COALESCE(data->'transcript', '[]'::jsonb)) > 0
     ORDER BY start_time ASC`,
    [SINCE_ISO],
  );

  console.log(`[Backfill] ${rows.length} arama bulundu (>= ${SINCE_ISO})`);

  let done = 0, failed = 0;

  const scenarioPromptOnce = await (async () => {
    // Tüm kayıtlarda scenarioId boş olduğunu biliyoruz (DB doğrulaması yapıldı) —
    // canlı Vapi promptunu bir kez çekip cache'in devreye girmesini sağlıyoruz.
    try { return await getAssistantSystemPrompt(); } catch { return null; }
  })();
  console.log(`[Backfill] Kullanılacak canlı prompt: "${scenarioPromptOnce?.name || 'bilinmiyor'}"`);

  await runWithConcurrency(rows, 3, async ({ vapi_call_id }) => {
    try {
      const record = await readCall(vapi_call_id);
      if (!record || !record.transcript.length) return;

      const history = record.transcript.map(t => ({ role: t.role, content: t.text }));
      const scenarioPrompt = await resolveScenarioPromptForSummary(record);
      const summary = await generateCallSummary(record.customerInfo, history, scenarioPrompt);
      await saveCallSummary(vapi_call_id, summary);

      done++;
      console.log(`[Backfill] ✓ ${record.customerName} (${vapi_call_id}) — randevu:${summary.randevu_alindi} ilgi:${summary.ilgi_seviyesi}`);
    } catch (err) {
      failed++;
      console.error(`[Backfill] ✗ ${vapi_call_id}:`, err);
    }
  });

  console.log(`\n[Backfill] Tamamlandı — ${done} başarılı, ${failed} hatalı, toplam ${rows.length}`);
  await pool.end();
}

main().catch(err => {
  console.error('[Backfill] Fatal hata:', err);
  process.exit(1);
});
