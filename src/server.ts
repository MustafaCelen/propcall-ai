// PropCall AI - Express sunucusu

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

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

const app   = express();
const PORT  = process.env.PORT || 5000;
const HOST  = '0.0.0.0';

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

    const scenario = scenarioId ? getScenario(scenarioId) : null;
    const vapiCall = await createVapiCall(customer, scenario?.systemPrompt);
    const record   = createCall(vapiCall.id, customer, scenario?.id, scenario?.name);

    console.log(`[Vapi] Arama başlatıldı: ${vapiCall.id} → ${customer.phone}`);
    return res.json({ success: true, data: { callId: vapiCall.id, recordId: record.callId } });
  } catch (err) {
    console.error('[API] /call hatası:', err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Aramayı sonlandır
app.delete('/api/call/:vapiCallId', async (req: Request, res: Response) => {
  try {
    await endVapiCall(req.params.vapiCallId);
    updateCall(req.params.vapiCallId, { status: 'completed', endTime: new Date().toISOString() });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── VAPI: Webhook ────────────────────────────────────────────────────────────

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);

  const payload = req.body as VapiWebhookPayload;
  const msg     = payload?.message;
  if (!msg?.type) return;

  const vapiCallId = msg.call?.id;
  console.log(`[Webhook] ${msg.type}${vapiCallId ? ` | ${vapiCallId}` : ''}`);

  switch (msg.type) {

    case 'call-started':
      if (!vapiCallId) break;
      updateCall(vapiCallId, { status: 'in-progress' });
      broadcast('call-started', { vapiCallId });
      break;

    case 'transcript':
      if (!vapiCallId || msg.transcriptType !== 'final' || !msg.transcript || !msg.role) break;
      const entry = { role: msg.role, text: msg.transcript, timestamp: new Date().toISOString() };
      appendTranscript(vapiCallId, entry);
      broadcast('transcript', { vapiCallId, ...entry });
      break;

    case 'cost-update': {
      if (!vapiCallId) break;
      const costs = parseCosts(msg.costs, msg.cost);
      if (costs) {
        updateCosts(vapiCallId, costs);
        broadcast('cost-update', { vapiCallId, costs });
      }
      break;
    }

    case 'end-of-call-report': {
      if (!vapiCallId) break;
      const endedAt    = msg.call?.endedAt || new Date().toISOString();
      const duration   = msg.call?.duration;
      const endReason  = msg.call?.endedReason;
      const status     = endedReasonToStatus(endReason);
      const recording  = msg.recordingUrl || msg.artifact?.recordingUrl;
      console.log(`[Webhook] end-of-call-report → endedReason: "${endReason}" → status: "${status}" | süre: ${duration ?? '?'}s`);
      const costs      = parseCosts(msg.costs, msg.cost);

      // artifact.messages her zaman tam konuşmayı içerir (assistant + user).
      // Varsa mevcut transcript'i silerek artifact'tan yeniden yaz.
      if (msg.artifact?.messages?.length) {
        updateCall(vapiCallId, { transcript: [] } as any);
        msg.artifact.messages.forEach((m: any) => {
          if (m.role !== 'assistant' && m.role !== 'user') return;
          // Vapi farklı versiyonlarda message, content veya text kullanabilir
          const text: string = m.message || m.content || m.text || '';
          if (!text.trim()) return;
          appendTranscript(vapiCallId, {
            role: m.role as 'assistant' | 'user',
            text,
            timestamp: new Date(m.time || m.timestamp || Date.now()).toISOString(),
          });
        });
        console.log(`[Webhook] ${vapiCallId} transcript artifact'tan yazıldı: ${msg.artifact.messages.filter((m:any) => m.role==='assistant'||m.role==='user').length} mesaj`);
      } else {
        console.warn(`[Webhook] ${vapiCallId} artifact.messages yok`);
      }

      updateCall(vapiCallId, {
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
      const existing  = readCall(vapiCallId);
      // end-of-call-report zaten 'completed' set ettiyse call-ended ile ezme
      const alreadyDone = existing?.status && existing.status !== 'in-progress';
      const newReason   = msg.call?.endedReason;
      const s2 = newReason
        ? endedReasonToStatus(newReason)
        : alreadyDone ? existing!.status : 'failed';
      updateCall(vapiCallId, { status: s2, endTime: new Date().toISOString() } as any);
      broadcast('call-ended', { vapiCallId, endedReason: newReason, status: s2 });
      break;
    }
  }
});

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
  const record = readCall(vapiCallId);
  if (!record || !record.transcript.length) return;
  try {
    const history  = record.transcript.map(t => ({ role: t.role, content: t.text }));
    const summary  = await generateCallSummary(record.customerInfo, history);
    saveCallSummary(vapiCallId, summary);
    broadcast('summary-ready', { vapiCallId, summary });
    console.log(`[AI] Özet hazır: ${vapiCallId}`);
  } catch (err) {
    console.error('[AI] Özet hatası:', err);
    broadcast('summary-error', { vapiCallId, error: String(err) });
  }
}

// ─── TAKİP LİSTESİ ───────────────────────────────────────────────────────────

app.get('/api/followup', (_req: Request, res: Response) => {
  try {
    const all = getAllCalls();
    const finished = all.filter(c => c.status !== 'in-progress' && c.summary);

    const ilgiRank: Record<string, number> = { yüksek: 3, orta: 2, düşük: 1, yok: 0 };
    const byIlgi = (a: typeof finished[0], b: typeof finished[0]) =>
      (ilgiRank[b.summary?.ilgi_seviyesi ?? 'yok'] ?? 0) -
      (ilgiRank[a.summary?.ilgi_seviyesi ?? 'yok'] ?? 0);

    const byAction = (action: string) =>
      finished.filter(c => c.summary!.tavsiye_edilen_aksiyon === action).sort(byIlgi);

    return res.json({
      success: true,
      data: {
        randevuAlanlar:  finished.filter(c => c.summary!.randevu_alindi === true)
                                 .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()),
        geriAranacaklar: byAction('Ara'),
        beklemeListesi:  byAction('Bekleme listesine al'),
        manuelTakip:     all.filter(c => c.followUp && c.summary?.tavsiye_edilen_aksiyon !== 'Uğraşma')
                            .sort(byIlgi),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── ARAMALAR ─────────────────────────────────────────────────────────────────

app.get('/api/calls', (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId } = req.query as Record<string, string>;
    const filters: CallFilters = { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId };
    return res.json({ success: true, data: getAllCalls(filters) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/api/calls/:id', (req: Request, res: Response) => {
  const record = readCall(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
  return res.json({ success: true, data: record });
});

app.patch('/api/calls/:id', (req: Request, res: Response) => {
  try {
    const { notes, followUp } = req.body as { notes?: string; followUp?: boolean };
    const updates: Record<string, unknown> = {};
    if (notes     !== undefined) updates.notes    = notes;
    if (followUp  !== undefined) updates.followUp = followUp;
    const record = updateCall(req.params.id, updates as any);
    if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    return res.json({ success: true, data: record });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/generate-summary', async (req: Request, res: Response) => {
  try {
    const { vapiCallId } = req.body as { vapiCallId: string };
    const record = readCall(vapiCallId);
    if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    const history = record.transcript.map(t => ({ role: t.role, content: t.text }));
    const summary = await generateCallSummary(record.customerInfo, history);
    saveCallSummary(vapiCallId, summary);
    return res.json({ success: true, data: summary });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── İSTATİSTİK ──────────────────────────────────────────────────────────────

app.get('/api/stats', (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: getStats() });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────

app.get('/api/export', (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId } = req.query as Record<string, string>;
    const filters: CallFilters = { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId };
    const csv = exportCSV(filters);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="propcall-export.csv"' });
    return res.send('﻿' + csv); // BOM for Excel
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── RANDEVULAR ──────────────────────────────────────────────────────────────

app.get('/api/appointments', (_req, res) => {
  try { return res.json({ success: true, data: getAllAppointments() }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/appointments', (req, res) => {
  try {
    const { customerName, customerPhone, date, time, address, notes } = req.body;
    if (!customerName || !date || !time)
      return res.status(400).json({ success: false, error: 'Ad, tarih ve saat zorunlu' });
    return res.status(201).json({ success: true, data: saveAppointment({ customerName, customerPhone, date, time, address, notes }) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/appointments/:id', (req, res) => {
  try {
    if (!deleteAppointment(req.params.id))
      return res.status(404).json({ success: false, error: 'Randevu bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── SENARYOLAR ──────────────────────────────────────────────────────────────

app.get('/api/scenarios', (_req, res) => {
  try { return res.json({ success: true, data: getAllScenarios() }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/scenarios', (req, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    if (!name || !systemPrompt)
      return res.status(400).json({ success: false, error: 'Ad ve prompt zorunlu' });
    return res.status(201).json({ success: true, data: createScenario(name, systemPrompt) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/scenarios/:id', (req, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    const updated = updateScenario(req.params.id, name, systemPrompt);
    if (!updated) return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true, data: updated });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/scenarios/:id', (req, res) => {
  try {
    if (!deleteScenario(req.params.id))
      return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── CAMPAIGN STATE ──────────────────────────────────────────────────────────

const CAMPAIGN_FILE = path.join(__dirname, '..', 'data', 'campaign.json');

app.get('/api/campaign', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(CAMPAIGN_FILE)) return res.json({ success: true, data: null });
    const data = JSON.parse(fs.readFileSync(CAMPAIGN_FILE, 'utf-8'));
    return res.json({ success: true, data });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign', (req: Request, res: Response) => {
  try {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CAMPAIGN_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/campaign', (_req: Request, res: Response) => {
  try {
    if (fs.existsSync(CAMPAIGN_FILE)) fs.unlinkSync(CAMPAIGN_FILE);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── BAŞLAT ──────────────────────────────────────────────────────────────────

app.listen(Number(PORT), HOST, () => {
  console.log(`\n✅ PropCall AI sunucusu başlatıldı`);
  console.log(`   → http://${HOST}:${PORT}`);
  console.log(`   → Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`);
  console.log(`   → Vapi:      ${process.env.VAPI_API_KEY ? '✓' : '✗'}\n`);
});
