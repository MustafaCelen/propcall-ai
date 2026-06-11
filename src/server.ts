import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { initDb } from './db';
import pool from './db';
import { generateCallSummary } from './ai';
import { createVapiCall, endVapiCall } from './vapi';
import { getAllAppointments, saveAppointment, deleteAppointment } from './appointments';
import { getAllScenarios, getScenario, createScenario, updateScenario, deleteScenario } from './scenarios';
import {
  getAllCalls, readCall, createCall, updateCall,
  appendTranscript, updateCosts, saveCallSummary,
  endedReasonToStatus, getStats, exportCSV,
} from './calls';
import { VapiCallRequest, VapiWebhookPayload, VapiCostItem, CallFilters } from './types';

const app  = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Set<Response>();

function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch { sseClients.delete(c); } });
}

app.get('/api/events', (req: Request, res: Response) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── VAPI: Arama başlat ───────────────────────────────────────────────────────

app.post('/api/call', async (req: Request, res: Response) => {
  try {
    const { customer, scenarioId } = req.body as VapiCallRequest;
    if (!customer?.name || !customer?.phone)
      return res.status(400).json({ success: false, error: 'Ad ve telefon zorunlu' });

    const scenario = scenarioId ? await getScenario(scenarioId) : null;
    const vapiCall = await createVapiCall(customer, scenario?.systemPrompt);
    const record   = await createCall(vapiCall.id, customer, scenario?.id, scenario?.name);

    console.log(`[Vapi] Arama başlatıldı: ${vapiCall.id} → ${customer.phone}`);
    return res.json({ success: true, data: { callId: vapiCall.id, recordId: record.callId } });
  } catch (err) {
    console.error('[API] /call hatası:', err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.delete('/api/call/:vapiCallId', async (req: Request, res: Response) => {
  try {
    await endVapiCall(req.params.vapiCallId);
    await updateCall(req.params.vapiCallId, { status: 'completed', endTime: new Date().toISOString() });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── VAPI: Webhook ────────────────────────────────────────────────────────────

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);
  handleWebhook(req.body as VapiWebhookPayload).catch(console.error);
});

async function handleWebhook(payload: VapiWebhookPayload): Promise<void> {
  const msg = payload?.message;
  if (!msg?.type) return;

  const vapiCallId = msg.call?.id;
  console.log(`[Webhook] ${msg.type}${vapiCallId ? ` | ${vapiCallId}` : ''}`);

  switch (msg.type) {

    case 'call-started':
      if (!vapiCallId) break;
      await updateCall(vapiCallId, { status: 'in-progress' });
      broadcast('call-started', { vapiCallId });
      break;

    case 'transcript':
      if (!vapiCallId || msg.transcriptType !== 'final' || !msg.transcript || !msg.role) break;
      const entry = { role: msg.role, text: msg.transcript, timestamp: new Date().toISOString() };
      await appendTranscript(vapiCallId, entry);
      broadcast('transcript', { vapiCallId, ...entry });
      break;

    case 'cost-update': {
      if (!vapiCallId) break;
      const costs = parseCosts(msg.costs, msg.cost);
      if (costs) {
        await updateCosts(vapiCallId, costs);
        broadcast('cost-update', { vapiCallId, costs });
      }
      break;
    }

    case 'end-of-call-report': {
      if (!vapiCallId) break;
      const endedAt   = msg.call?.endedAt || new Date().toISOString();
      const duration  = msg.call?.duration;
      const endReason = msg.call?.endedReason;
      const status    = endedReasonToStatus(endReason);
      const recording = msg.recordingUrl || msg.artifact?.recordingUrl;
      const costs     = parseCosts(msg.costs, msg.cost);

      console.log(`[Webhook] end-of-call-report → endedReason: "${endReason}" → status: "${status}" | süre: ${duration ?? '?'}s`);

      if (msg.artifact?.messages?.length) {
        await updateCall(vapiCallId, { transcript: [] } as any);
        for (const m of msg.artifact.messages as any[]) {
          if (m.role !== 'assistant' && m.role !== 'user') continue;
          const text: string = m.message || m.content || m.text || '';
          if (!text.trim()) continue;
          await appendTranscript(vapiCallId, {
            role: m.role as 'assistant' | 'user',
            text,
            timestamp: new Date(m.time || m.timestamp || Date.now()).toISOString(),
          });
        }
        console.log(`[Webhook] ${vapiCallId} transcript artifact'tan yazıldı`);
      } else {
        console.warn(`[Webhook] ${vapiCallId} artifact.messages yok`);
      }

      await updateCall(vapiCallId, {
        status, endTime: endedAt, duration,
        endedReason: endReason,
        recordingUrl: recording,
        ...(costs ? { costs } : {}),
      } as any);

      broadcast('call-ended', { vapiCallId, endedReason: endReason, duration, status });
      generateSummaryForCall(vapiCallId).catch(console.error);
      break;
    }

    case 'call-ended': {
      if (!vapiCallId) break;
      const existing    = await readCall(vapiCallId);
      const alreadyDone = existing?.status && existing.status !== 'in-progress';
      const newReason   = msg.call?.endedReason;
      const s2 = newReason
        ? endedReasonToStatus(newReason)
        : alreadyDone ? existing!.status : 'failed';
      await updateCall(vapiCallId, { status: s2, endTime: new Date().toISOString() } as any);
      broadcast('call-ended', { vapiCallId, endedReason: newReason, status: s2 });
      break;
    }
  }
}

function parseCosts(costsArr?: VapiCostItem[], totalFallback?: number) {
  if (!costsArr?.length && !totalFallback) return null;
  const c = { vapi: 0, twilio: 0, llm: 0, tts: 0, stt: 0, total: 0 };
  if (costsArr?.length) {
    costsArr.forEach(item => {
      switch (item.type) {
        case 'vapi':        c.vapi   += item.cost || 0; break;
        case 'transport':   c.twilio += item.cost || 0; break;
        case 'model':       c.llm    += item.cost || 0; break;
        case 'voice':       c.tts    += item.cost || 0; break;
        case 'transcriber': c.stt    += item.cost || 0; break;
      }
      c.total += item.cost || 0;
    });
  } else if (totalFallback) {
    c.total = totalFallback;
  }
  return c;
}

async function generateSummaryForCall(vapiCallId: string): Promise<void> {
  const record = await readCall(vapiCallId);
  if (!record || !record.transcript.length) return;
  try {
    const history = record.transcript.map(t => ({ role: t.role, content: t.text }));
    const summary = await generateCallSummary(record.customerInfo, history);
    await saveCallSummary(vapiCallId, summary);
    broadcast('summary-ready', { vapiCallId, summary });
    console.log(`[AI] Özet hazır: ${vapiCallId}`);
  } catch (err) {
    console.error('[AI] Özet hatası:', err);
    broadcast('summary-error', { vapiCallId, error: String(err) });
  }
}

// ─── TAKİP LİSTESİ ───────────────────────────────────────────────────────────

app.get('/api/followup', async (_req: Request, res: Response) => {
  try {
    const all      = await getAllCalls();
    const finished = all.filter(c => c.status !== 'in-progress' && c.summary);

    const ilgiRank: Record<string, number> = { yüksek: 3, orta: 2, düşük: 1, yok: 0 };
    const byIlgi = (a: typeof finished[0], b: typeof finished[0]) =>
      (ilgiRank[b.summary?.ilgi_seviyesi ?? 'yok'] ?? 0) -
      (ilgiRank[a.summary?.ilgi_seviyesi ?? 'yok'] ?? 0);

    const byAction = (action: string) =>
      finished.filter(c => c.summary!.tavsiye_edilen_aksiyon === action).sort(byIlgi);

    // Cevapsız / Tekrar Ara: her telefon numarası için en son arama no-answer veya busy ise listeye ekle
    const phoneLatest = new Map<string, typeof all[0]>();
    all.forEach(c => {
      const ex = phoneLatest.get(c.customerPhone);
      if (!ex || new Date(c.startTime) > new Date(ex.startTime)) phoneLatest.set(c.customerPhone, c);
    });
    const retryCounts = new Map<string, number>();
    all.filter(c => c.status === 'no-answer' || c.status === 'busy')
       .forEach(c => retryCounts.set(c.customerPhone, (retryCounts.get(c.customerPhone) || 0) + 1));
    const cevapsizilar = Array.from(phoneLatest.values())
      .filter(c => c.status === 'no-answer' || c.status === 'busy')
      .map(c => ({ ...c, retryCount: retryCounts.get(c.customerPhone) || 1 }))
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

    return res.json({
      success: true,
      data: {
        randevuAlanlar:  finished.filter(c => c.summary!.randevu_alindi === true)
                                 .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()),
        geriAranacaklar: byAction('Ara'),
        beklemeListesi:  byAction('Bekleme listesine al'),
        manuelTakip:     all.filter(c => c.followUp).sort(byIlgi),
        cevapsizilar,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── ARAMALAR ─────────────────────────────────────────────────────────────────

app.get('/api/calls', async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId } = req.query as Record<string, string>;
    const filters: CallFilters = { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId };
    return res.json({ success: true, data: await getAllCalls(filters) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/api/calls/:id', async (req: Request, res: Response) => {
  const record = await readCall(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
  return res.json({ success: true, data: record });
});

app.patch('/api/calls/:id', async (req: Request, res: Response) => {
  try {
    const { notes, followUp } = req.body as { notes?: string; followUp?: boolean };
    const updates: Record<string, unknown> = {};
    if (notes    !== undefined) updates.notes    = notes;
    if (followUp !== undefined) updates.followUp = followUp;
    const record = await updateCall(req.params.id, updates as any);
    if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    return res.json({ success: true, data: record });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/generate-summary', async (req: Request, res: Response) => {
  try {
    const { vapiCallId } = req.body as { vapiCallId: string };
    const record = await readCall(vapiCallId);
    if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    const history = record.transcript.map(t => ({ role: t.role, content: t.text }));
    const summary = await generateCallSummary(record.customerInfo, history);
    await saveCallSummary(vapiCallId, summary);
    return res.json({ success: true, data: summary });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── İSTATİSTİK ──────────────────────────────────────────────────────────────

app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await getStats() });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────

app.get('/api/export', async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId } = req.query as Record<string, string>;
    const filters: CallFilters = { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId };
    const csv = await exportCSV(filters);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="propcall-export.csv"' });
    return res.send('﻿' + csv);
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── RANDEVULAR ──────────────────────────────────────────────────────────────

app.get('/api/appointments', async (_req, res) => {
  try { return res.json({ success: true, data: await getAllAppointments() }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { customerName, customerPhone, date, time, address, notes } = req.body;
    if (!customerName || !date || !time)
      return res.status(400).json({ success: false, error: 'Ad, tarih ve saat zorunlu' });
    return res.status(201).json({ success: true, data: await saveAppointment({ customerName, customerPhone, date, time, address, notes }) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    if (!await deleteAppointment(req.params.id))
      return res.status(404).json({ success: false, error: 'Randevu bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── SENARYOLAR ──────────────────────────────────────────────────────────────

app.get('/api/scenarios', async (_req, res) => {
  try { return res.json({ success: true, data: await getAllScenarios() }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/scenarios', async (req, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    if (!name || !systemPrompt)
      return res.status(400).json({ success: false, error: 'Ad ve prompt zorunlu' });
    return res.status(201).json({ success: true, data: await createScenario(name, systemPrompt) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/scenarios/:id', async (req, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    const updated = await updateScenario(req.params.id, name, systemPrompt);
    if (!updated) return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true, data: updated });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/scenarios/:id', async (req, res) => {
  try {
    if (!await deleteScenario(req.params.id))
      return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── CAMPAIGN STATE ──────────────────────────────────────────────────────────

app.get('/api/campaign', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT data FROM campaign_state WHERE id = 'current'`,
    );
    return res.json({ success: true, data: rows[0]?.data ?? null });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign', async (req: Request, res: Response) => {
  try {
    await pool.query(
      `INSERT INTO campaign_state (id, data, updated_at)
       VALUES ('current', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(req.body)],
    );
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/campaign', async (_req: Request, res: Response) => {
  try {
    await pool.query(`DELETE FROM campaign_state WHERE id = 'current'`);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── BAŞLAT ──────────────────────────────────────────────────────────────────

initDb()
  .then(() => {
    app.listen(Number(PORT), HOST, () => {
      console.log(`\n✅ PropCall AI sunucusu başlatıldı`);
      console.log(`   → http://${HOST}:${PORT}`);
      console.log(`   → Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`);
      console.log(`   → Vapi:      ${process.env.VAPI_API_KEY ? '✓' : '✗'}`);
      console.log(`   → Database:  ${process.env.DATABASE_URL ? '✓' : '✗'}\n`);
    });
  })
  .catch(err => {
    console.error('❌ Veritabanı başlatılamadı:', err);
    process.exit(1);
  });
