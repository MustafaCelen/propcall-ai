// PropCall AI - Express sunucusu

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { spawn } from 'child_process';

dotenv.config();

import { generateCallSummary } from './ai';
import { createVapiCall, endVapiCall, fetchVapiCall } from './vapi';
import { getAllAppointments, saveAppointment, deleteAppointment } from './appointments';
import {
  getAllCalls, readCall, createCall, updateCall,
  appendTranscript, updateCosts, saveCallSummary,
  endedReasonToStatus, getStats, exportCSV,
} from './calls';
import { VapiCallRequest, VapiWebhookPayload, VapiCostItem, CallFilters } from './types';

const app   = express();
const PORT  = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── TUNNEL URL ──────────────────────────────────────────────────────────────
let tunnelWebhookUrl: string | null = null;

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
    const { customer } = req.body as VapiCallRequest;
    if (!customer?.name || !customer?.phone)
      return res.status(400).json({ success: false, error: 'Ad ve telefon zorunlu' });

    const vapiCall = await createVapiCall(customer, tunnelWebhookUrl ?? undefined);
    const record   = createCall(vapiCall.id, customer);

    console.log(`[Vapi] Arama başlatıldı: ${vapiCall.id} → ${customer.phone}`);
    pollCallUntilEnded(vapiCall.id).catch(console.error);
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
      const costs      = parseCosts(msg.costs, msg.cost);

      // artifact.messages'dan transcript yoksa doldur
      const record = readCall(vapiCallId);
      if (record && record.transcript.length === 0 && msg.artifact?.messages?.length) {
        msg.artifact.messages.forEach(m => {
          if (m.role === 'assistant' || m.role === 'user') {
            appendTranscript(vapiCallId, {
              role: m.role as 'assistant' | 'user',
              text: m.message,
              timestamp: new Date(m.time).toISOString(),
            });
          }
        });
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

    case 'call-ended':
      if (!vapiCallId) break;
      const s = endedReasonToStatus(msg.call?.endedReason);
      updateCall(vapiCallId, { status: s, endTime: new Date().toISOString() } as any);
      broadcast('call-ended', { vapiCallId, endedReason: msg.call?.endedReason, status: s });
      break;
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

async function pollCallUntilEnded(vapiCallId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {        // maks 5 dk (60 × 5s)
    await new Promise(r => setTimeout(r, 5000));
    const data = await fetchVapiCall(vapiCallId);
    if (!data || data.status !== 'ended') continue;

    const endReason  = data.endedReason;
    const status     = endedReasonToStatus(endReason);
    const endTime    = data.endedAt || new Date().toISOString();
    const duration   = data.call?.duration ?? data.durationSeconds;
    const recording  = data.artifact?.recordingUrl ?? data.recordingUrl;
    const costs      = parseCosts(data.costs, data.cost);

    // Transcript — artifact.messages
    const record = readCall(vapiCallId);
    if (record && record.transcript.length === 0 && data.artifact?.messages?.length) {
      data.artifact.messages.forEach((m: any) => {
        if (m.role === 'assistant' || m.role === 'user') {
          appendTranscript(vapiCallId, {
            role: m.role as 'assistant' | 'user',
            text: m.message ?? m.content ?? '',
            timestamp: m.time ? new Date(m.time).toISOString() : new Date().toISOString(),
          });
        }
      });
    }

    updateCall(vapiCallId, {
      status, endTime, duration,
      endedReason: endReason,
      recordingUrl: recording,
      ...(costs ? { costs } : {}),
    } as any);

    broadcast('call-ended', { vapiCallId, endedReason: endReason, duration, status });
    console.log(`[Poll] Arama bitti: ${vapiCallId} → ${endReason}`);
    generateSummaryForCall(vapiCallId).catch(console.error);
    break;
  }
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

// ─── ARAMALAR ─────────────────────────────────────────────────────────────────

app.get('/api/calls', (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, minScore, maxScore, niyet, aksiyon, status } = req.query as Record<string, string>;
    const filters: CallFilters = {
      dateFrom, dateTo, niyet, aksiyon, status,
      minScore: minScore !== undefined ? Number(minScore) : undefined,
      maxScore: maxScore !== undefined ? Number(maxScore) : undefined,
    };
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
    const { dateFrom, dateTo, minScore, maxScore, niyet, aksiyon, status } = req.query as Record<string, string>;
    const filters: CallFilters = {
      dateFrom, dateTo, niyet, aksiyon, status,
      minScore: minScore !== undefined ? Number(minScore) : undefined,
      maxScore: maxScore !== undefined ? Number(maxScore) : undefined,
    };
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

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── CLOUDFLARE TUNNEL ───────────────────────────────────────────────────────

function startTunnel(port: number): void {
  const ngrokPath = 'C:\\Users\\musta\\ngrok.exe';
  const ng = spawn(ngrokPath, ['http', String(port)], { windowsHide: true });

  ng.on('error', (err) => console.error('[Tunnel] ngrok başlatılamadı:', err.message));
  ng.on('close', (code) => console.log(`[Tunnel] Kapandı (${code})`));

  // ngrok API'den URL'i al
  setTimeout(async () => {
    try {
      const res  = await fetch('http://localhost:4040/api/tunnels');
      const json = await res.json() as any;
      const tunnelUrl = (json.tunnels as any[]).find((t: any) => t.proto === 'https')?.public_url;
      if (!tunnelUrl) { console.error('[Tunnel] ngrok URL bulunamadı'); return; }
      tunnelWebhookUrl = `${tunnelUrl}/webhook`;
      console.log(`   → Tunnel:  ${tunnelUrl}`);
      console.log(`   → Webhook: ${tunnelWebhookUrl}\n`);
      const assistantId = process.env.VAPI_ASSISTANT_ID;
      if (assistantId && process.env.VAPI_API_KEY) {
        await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverUrl: tunnelWebhookUrl }),
        });
        console.log(`   → Vapi serverUrl güncellendi ✓\n`);
      }
    } catch (err) {
      console.error('[Tunnel] ngrok API hatası:', err);
    }
  }, 3000);
}

// ─── BAŞLAT ──────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n✅ PropCall AI sunucusu başlatıldı`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`);
  console.log(`   → Vapi:      ${process.env.VAPI_API_KEY ? '✓' : '✗'}\n`);

  startTunnel(Number(PORT));
});
