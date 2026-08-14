// Tek seferlik doğrulama scripti: getStats()'in SQL agregasyonunu, ham `calls`
// verisinden BAĞIMSIZ bir JS hesaplamasıyla çapraz kontrol eder. Amaç: SQL'de
// gizli bir çift-sayma / yanlış filtre / JOIN hatası olup olmadığını yakalamak.
//
// Kullanım: npx ts-node scripts/verify-stats.ts

import dotenv from 'dotenv';
dotenv.config();

import pool from '../src/db';
import { getStats, getCampaignStats } from '../src/calls';
import { CallRecord } from '../src/types';

function fail(label: string, expected: unknown, actual: unknown): void {
  console.error(`  ✗ ${label}: SQL=${JSON.stringify(actual)} ≠ JS=${JSON.stringify(expected)}`);
}
function ok(label: string): void {
  console.log(`  ✓ ${label}`);
}

async function verifyGlobalStats() {
  console.log('\n=== getStats() (tüm zamanlar) doğrulaması ===');

  const { rows } = await pool.query<{ data: CallRecord }>('SELECT data FROM calls');
  const calls = rows.map(r => r.data);

  const sql = await getStats(); // periodDays yok = tüm zamanlar

  let errors = 0;
  const check = (label: string, expected: unknown, actual: unknown) => {
    const same = JSON.stringify(expected) === JSON.stringify(actual);
    if (same) { ok(label); } else { fail(label, expected, actual); errors++; }
  };

  // Toplam / cevaplanan
  const totalCalls = calls.length;
  const completedCalls = calls.filter(c => c.status === 'completed').length;
  check('totalCalls', totalCalls, sql.totalCalls);
  check('completedCalls', completedCalls, sql.completedCalls);
  check('answerRate', totalCalls ? Math.round(completedCalls / totalCalls * 100) : 0, sql.answerRate);

  // Randevu
  const withSummary = calls.filter(c => c.summary && c.status !== 'in-progress');
  const randevuCount = withSummary.filter(c => c.summary!.randevu_alindi === true).length;
  check('randevuCount', randevuCount, sql.randevuCount);
  check('randevuRate', withSummary.length ? Math.round(randevuCount / withSummary.length * 100) : 0, sql.randevuRate);

  // Maliyet (4 ondalık yuvarlama SQL tarafıyla aynı olmalı)
  const totalCost = Math.round(calls.reduce((s, c) => s + (c.costs?.total || 0), 0) * 10000) / 10000;
  check('totalCost', totalCost, sql.totalCost);

  // Ortalama süre (in-progress hariç)
  const finished = calls.filter(c => c.status !== 'in-progress' && c.duration != null);
  const avgDuration = finished.length
    ? Math.round(finished.reduce((s, c) => s + (c.duration || 0), 0) / finished.length)
    : 0;
  check('avgDuration', avgDuration, sql.avgDuration);

  // İlgi dağılımı
  const ilgiMap: Record<string, number> = { yüksek: 0, orta: 0, düşük: 0, yok: 0 };
  withSummary.forEach(c => { const s = c.summary!.ilgi_seviyesi || 'yok'; ilgiMap[s] = (ilgiMap[s] || 0) + 1; });
  const ilgiExpected = ['yüksek', 'orta', 'düşük', 'yok'].map(s => ({ seviye: s, count: ilgiMap[s] }));
  check('ilgiDistribution', ilgiExpected, sql.ilgiDistribution);

  // Durum dağılımı
  const statusMap: Record<string, number> = {};
  calls.forEach(c => { statusMap[c.status] = (statusMap[c.status] || 0) + 1; });
  const statusExpected = Object.entries(statusMap)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => a.status.localeCompare(b.status));
  const statusActualSorted = [...sql.statusBreakdown].sort((a, b) => a.status.localeCompare(b.status));
  check('statusBreakdown', statusExpected, statusActualSorted);

  // İç tutarlılık: statusBreakdown toplamı totalCalls'a eşit olmalı
  const statusSum = sql.statusBreakdown.reduce((s, x) => s + x.count, 0);
  check('statusBreakdown toplamı == totalCalls', totalCalls, statusSum);

  console.log(errors === 0 ? '\n✅ getStats() TUTARLI — hiçbir sapma yok' : `\n❌ ${errors} sapma bulundu`);
  return errors;
}

async function verifyCampaignStats() {
  console.log('\n=== getCampaignStats() doğrulaması ===');
  const { rows: campRows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM campaigns ORDER BY created_at DESC LIMIT 1`,
  );
  if (!campRows[0]) {
    console.log('  (Henüz kampanya yok — atlanıyor)');
    return 0;
  }
  const { id, name } = campRows[0];
  console.log(`  Kampanya: "${name}" (${id})`);

  const { rows } = await pool.query<{ data: CallRecord }>(
    `SELECT data FROM calls WHERE data->>'campaignId' = $1`, [id],
  );
  const calls = rows.map(r => r.data);
  const sql = await getCampaignStats(id);

  let errors = 0;
  const check = (label: string, expected: unknown, actual: unknown) => {
    const same = JSON.stringify(expected) === JSON.stringify(actual);
    if (same) { ok(label); } else { fail(label, expected, actual); errors++; }
  };

  const totalCalls = calls.length;
  const completedCalls = calls.filter(c => c.status === 'completed').length;
  check('totalCalls', totalCalls, sql.totalCalls);
  check('completedCalls', completedCalls, sql.completedCalls);

  const withSummary = calls.filter(c => c.summary && c.status !== 'in-progress');
  const randevuCount = withSummary.filter(c => c.summary!.randevu_alindi === true).length;
  check('randevuCount', randevuCount, sql.randevuCount);

  const totalCost = Math.round(calls.reduce((s, c) => s + (c.costs?.total || 0), 0) * 10000) / 10000;
  check('totalCost', totalCost, sql.totalCost);

  console.log(errors === 0 ? '\n✅ getCampaignStats() TUTARLI' : `\n❌ ${errors} sapma bulundu`);
  return errors;
}

async function main() {
  const e1 = await verifyGlobalStats();
  const e2 = await verifyCampaignStats();
  await pool.end();
  process.exit(e1 + e2 === 0 ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
