import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { initDb } from './db';
import pool from './db';
import { generateCallSummary } from './ai';
import {
  createVapiCall, endVapiCall, getVapiCredit, getAssistantSystemPrompt, updateAssistantSystemPrompt,
  getSignedRecordingUrl, verifyVapiApiKey, getAssistantConfig, updateAssistantConfig, AssistantConfigPatch,
} from './vapi';
import { getElevenLabsCredit, listElevenLabsVoices } from './elevenlabs';
import { getAllAppointments, saveAppointment, deleteAppointment } from './appointments';
import { getAllScenarios, getScenario, createScenario, updateScenario, deleteScenario } from './scenarios';
import {
  getAllCalls, readCall, createCall, updateCall,
  appendTranscript, updateCosts, saveCallSummary,
  endedReasonToStatus, getStats, exportCSV, getCampaignStats,
} from './calls';
import { VapiCallRequest, VapiWebhookPayload, VapiCostItem, CallFilters, CallRecord } from './types';
import {
  initCampaignRunner, loadCampaignFromDb, getCampaignState,
  campaignLoad, campaignStart, campaignResume, campaignPause, campaignStop, campaignClear,
  onCampaignCallEnded, onCampaignSummaryReady,
} from './campaign';
import { listCampaigns, getCampaign } from './campaigns';
import { adminLogin, adminLogout, requireAdminAuth } from './admin-auth';
import { SETTINGS_KEYS, SettingsKey, getSetting, setSetting, getSettingsForAdmin } from './settings';
import { generateVapiPrompt, PromptGenInput } from './promptgen';

const app  = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── ADMİN PANEL — API key yönetimi ───────────────────────────────────────────

app.post('/api/admin/login',  adminLogin);
app.post('/api/admin/logout', adminLogout);

app.get('/api/admin/session', requireAdminAuth, (_req: Request, res: Response) => {
  res.json({ success: true });
});

app.get('/api/admin/settings', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const data = await getSettingsForAdmin();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.put('/api/admin/settings', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { key, value } = req.body as { key: SettingsKey; value: string };
    if (!SETTINGS_KEYS.includes(key)) {
      return res.status(400).json({ success: false, error: 'Geçersiz anahtar' });
    }
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ success: false, error: 'Değer boş olamaz' });
    }
    await setSetting(key, value.trim());
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Kaydetmeden önce Vapi key'ini hızlıca doğrula
app.post('/api/admin/settings/verify-vapi', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { value } = req.body as { value: string };
    if (!value?.trim()) return res.status(400).json({ success: false, error: 'Değer boş olamaz' });
    const result = await verifyVapiApiKey(value.trim());
    return res.json({ success: result.ok, error: result.error });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── ADMİN PANEL — Asistan Ayarları (model/ses/transkripsiyon/davranış) ──────

app.get('/api/admin/assistant-config', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const data = await getAssistantConfig();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.put('/api/admin/assistant-config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const patch = req.body as AssistantConfigPatch;
    await updateAssistantConfig(patch);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/api/admin/elevenlabs-voices', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const data = await listElevenLabsVoices();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/admin', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

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

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); sseClients.delete(res); }
  }, 30000).unref();

  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
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

// Ses kaydı: DB'deki ham recordingUrl HIPAA bucket'ında imzasız erişilemiyor —
// her istekte Vapi'den taze imzalı URL alıp tarayıcıyı oraya yönlendiriyoruz.
app.get('/api/calls/:vapiCallId/recording', async (req: Request, res: Response) => {
  try {
    const url = await getSignedRecordingUrl(req.params.vapiCallId);
    if (!url) return res.status(404).json({ success: false, error: 'Kayıt bulunamadı' });
    return res.redirect(302, url);
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
      const endReason = msg.endedReason || msg.call?.endedReason;
      const recording = msg.recordingUrl || msg.artifact?.recordingUrl;
      const newCosts  = parseCosts(msg.costs, msg.cost);

      // Mevcut kaydı bir kez oku — transcript karşılaştırma + cost merge için
      const existing = await readCall(vapiCallId);
      const existingTranscriptLen = existing?.transcript?.length ?? 0;

      // hasUserSpeech: artifact.messages'ta veya streaming transcript'te user rolünde mesaj var mı?
      const artifactHasUserSpeech = !!(msg.artifact?.messages as any[] | undefined)?.some(m => {
        const role = String(m?.role || '').toLowerCase();
        const text = m?.message || m?.content || m?.text || '';
        return role === 'user' && String(text).trim().length > 0;
      });
      const streamingHasUserSpeech = !!existing?.transcript?.some(t => t.role === 'user');
      const hasUserSpeech = artifactHasUserSpeech || streamingHasUserSpeech;

      const status = endedReasonToStatus(endReason, { hasUserSpeech });

      console.log(`[Webhook] end-of-call-report → endedReason: "${endReason}" → status: "${status}" | süre: ${duration ?? '?'}s | userSpoke: ${hasUserSpeech}`);

      // Transcript: Artifact, streaming'den daha fazla geçerli mesaj içeriyorsa güncelle.
      // Aksi takdirde gerçek zamanlı gelen streaming transcript korunur.
      if (msg.artifact?.messages?.length) {
        // Vapi artifact.messages: role 'bot' | 'user' | 'system' | 'tool_calls' vb.
        // 'bot' = assistant. system/tool mesajlarını atla, geri kalanı normalize et.
        const validMessages = (msg.artifact.messages as any[]).flatMap(m => {
          const rawRole = String(m.role || '').toLowerCase();
          const normalizedRole: 'assistant' | 'user' | null =
            (rawRole === 'bot' || rawRole === 'assistant') ? 'assistant' :
            (rawRole === 'user') ? 'user' : null;
          if (!normalizedRole) return [];
          const text: string = m.message || m.content || m.text || '';
          if (!text.trim().length) return [];
          return [{ ...m, role: normalizedRole, text }];
        });

        if (validMessages.length > existingTranscriptLen) {
          await updateCall(vapiCallId, { transcript: [] } as any);
          for (const m of validMessages) {
            await appendTranscript(vapiCallId, {
              role: m.role as 'assistant' | 'user',
              text: m.text,
              timestamp: new Date(m.time || m.timestamp || Date.now()).toISOString(),
            });
          }
          console.log(`[Webhook] ${vapiCallId} transcript artifact'tan yazıldı (${validMessages.length} > ${existingTranscriptLen})`);
        } else {
          console.log(`[Webhook] ${vapiCallId} streaming transcript korundu (${existingTranscriptLen} >= ${validMessages.length})`);
        }
      } else {
        console.warn(`[Webhook] ${vapiCallId} artifact.messages yok — streaming transcript korundu`);
      }

      // Cost merge: cost-update ile biriken değerleri sıfırlamadan güncelle
      const mergedCosts = newCosts ? mergeCosts(existing?.costs, newCosts) : undefined;

      await updateCall(vapiCallId, {
        status, endTime: endedAt, duration,
        endedReason: endReason,
        recordingUrl: recording,
        ...(mergedCosts ? { costs: mergedCosts } : {}),
      } as any);

      broadcast('call-ended', { vapiCallId, endedReason: endReason, duration, status });
      onCampaignCallEnded(vapiCallId, status, duration).catch(console.error);
      generateSummaryForCall(vapiCallId).catch(console.error);
      break;
    }

    case 'call-ended': {
      if (!vapiCallId) break;
      const existing    = await readCall(vapiCallId);
      const alreadyDone = existing?.status && existing.status !== 'in-progress';
      const newReason   = msg.endedReason || msg.call?.endedReason;
      const s2 = newReason
        ? endedReasonToStatus(newReason)
        : alreadyDone ? existing!.status : 'failed';

      if (!alreadyDone) {
        // end-of-call-report henüz gelmedi — fallback olarak güncelle
        await updateCall(vapiCallId, { status: s2, endTime: new Date().toISOString() } as any);
        broadcast('call-ended', { vapiCallId, endedReason: newReason, status: s2 });
        onCampaignCallEnded(vapiCallId, s2).catch(console.error);
      } else {
        // end-of-call-report zaten işledi — sadece SSE gönder (broadcast zaten yapıldı)
        console.log(`[Webhook] call-ended: ${vapiCallId} zaten işlendi (${existing!.status}), atlanıyor`);
      }
      break;
    }
  }
}

// Vapi'nin farklı formatlarda gönderebileceği cost değerini güvenli şekilde sayıya çevir.
// item.cost bazen number, bazen nested object olabilir.
function extractCost(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  if (raw && typeof raw === 'object') {
    // Nested object'ten bilinen alanları dene
    const obj = raw as Record<string, unknown>;
    for (const key of ['cost', 'value', 'amount', 'total', 'price']) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return 0;
}

function parseCosts(costsArr?: VapiCostItem[], totalFallback?: number) {
  if (!costsArr?.length && !totalFallback) return null;
  const c = { vapi: 0, twilio: 0, llm: 0, tts: 0, stt: 0, total: 0 };
  if (costsArr?.length) {
    costsArr.forEach(item => {
      // extractCost: hem sayı hem nested-object formatlarını güvenle handle eder
      const cost = extractCost(item.cost);
      // Vapi farklı versiyonlarında type isimleri değişebiliyor — hepsini kapsa
      switch (item.type) {
        case 'vapi':
          c.vapi += cost; break;
        case 'transport':
        case 'telephony':
        case 'twilio':
          c.twilio += cost; break;
        case 'model':
        case 'llm':
          c.llm += cost; break;
        case 'voice':
        case 'tts':
          c.tts += cost; break;
        case 'transcriber':
        case 'stt':
          c.stt += cost; break;
        // analysisCost, knowledgeBase vb. → toplama ekle, kırılımda yok
      }
      c.total += cost;
    });
    // Toplam sıfırsa (tüm cost'lar bilinmeyen tip) fallback kullan
    if (c.total === 0 && totalFallback) c.total = totalFallback;
  } else if (totalFallback) {
    c.total = totalFallback;
  }
  // Her alanı normalleştir: NaN/Infinity → 0, sonra 6 ondalık yuvarlama
  const normalize = (v: number) => Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
  c.vapi   = normalize(c.vapi);
  c.twilio = normalize(c.twilio);
  c.llm    = normalize(c.llm);
  c.tts    = normalize(c.tts);
  c.stt    = normalize(c.stt);
  c.total  = normalize(c.total);
  return c;
}

function mergeCosts(
  existing: { vapi: number; twilio: number; llm: number; tts: number; stt: number; total: number } | undefined,
  incoming: { vapi: number; twilio: number; llm: number; tts: number; stt: number; total: number },
) {
  if (!existing) return incoming;
  return {
    vapi:   incoming.vapi   || existing.vapi,
    twilio: incoming.twilio || existing.twilio,
    llm:    incoming.llm    || existing.llm,
    tts:    incoming.tts    || existing.tts,
    stt:    incoming.stt    || existing.stt,
    // Toplam: cost-update birikimli olabileceğinden en yüksek değeri kullan
    total:  Math.max(incoming.total, existing.total),
  };
}

// Özet üretiminde kullanılacak gerçek senaryo promptunu çözer:
// 1) Arama özel bir senaryoya bağlıysa (lokal scenarios tablosu) → onun promptu
// 2) Değilse → Vapi'deki canlı (base) asistan promptu (cache'li, 5dk TTL)
// Böylece analiz kriterleri her zaman aramada GERÇEKTEN kullanılan script'e göre uyum sağlar.
async function resolveScenarioPromptForSummary(record: CallRecord): Promise<string | null> {
  if (record.scenarioId) {
    try {
      const scenario = await getScenario(record.scenarioId);
      if (scenario?.systemPrompt) return scenario.systemPrompt;
    } catch (err) {
      console.warn('[AI] Senaryo promptu alınamadı, Vapi canlı promptuna düşülüyor:', err);
    }
  }
  try {
    const { systemPrompt } = await getAssistantSystemPrompt();
    return systemPrompt || null;
  } catch (err) {
    console.warn('[AI] Vapi canlı asistan promptu alınamadı:', err);
    return null;
  }
}

async function generateSummaryForCall(vapiCallId: string, attempt = 1): Promise<void> {
  const record = await readCall(vapiCallId);
  if (!record) return;

  if (!record.transcript.length) {
    if (attempt <= 3) {
      const waitMs = attempt * 5000; // 5s, 10s, 15s
      console.log(`[AI] ${vapiCallId} transcript henüz hazır değil — ${waitMs / 1000}s bekleyip tekrar denenecek (deneme ${attempt}/3)`);
      setTimeout(() => generateSummaryForCall(vapiCallId, attempt + 1).catch(console.error), waitMs);
      return;
    }
    console.warn(`[AI] ${vapiCallId} transcript boş, özet oluşturulamadı`);
    return;
  }

  try {
    const history = record.transcript.map(t => ({ role: t.role, content: t.text }));
    const scenarioPrompt = await resolveScenarioPromptForSummary(record);
    const summary = await generateCallSummary(record.customerInfo, history, scenarioPrompt);
    await saveCallSummary(vapiCallId, summary);
    broadcast('summary-ready', { vapiCallId, summary });
    onCampaignSummaryReady(vapiCallId, summary).catch(console.error);
    console.log(`[AI] Özet hazır: ${vapiCallId}`);
  } catch (err) {
    console.error('[AI] Özet hatası:', err);
    broadcast('summary-error', { vapiCallId, error: String(err) });
  }
}

// ─── TAKİP LİSTESİ ───────────────────────────────────────────────────────────

app.get('/api/followup', async (_req: Request, res: Response) => {
  try {
    // Her grup için yalnızca ilgili satırları çek — tüm tabloyu belleğe almak yerine SQL filtresi
    const [randevuRes, geriRes, beklemeRes, manuelRes, cevapsiziRes] = await Promise.all([
      pool.query(
        `SELECT data FROM calls
         WHERE (data->'summary'->>'randevu_alindi')::boolean = true
         ORDER BY start_time DESC NULLS LAST`,
      ),
      pool.query(
        `SELECT data FROM calls
         WHERE data->'summary'->>'tavsiye_edilen_aksiyon' = 'Ara'
           AND status != 'in-progress'
         ORDER BY start_time DESC NULLS LAST`,
      ),
      pool.query(
        `SELECT data FROM calls
         WHERE data->'summary'->>'tavsiye_edilen_aksiyon' = 'Bekleme listesine al'
           AND status != 'in-progress'
         ORDER BY start_time DESC NULLS LAST`,
      ),
      pool.query(
        `SELECT data FROM calls
         WHERE (data->>'followUp')::boolean = true
         ORDER BY start_time DESC NULLS LAST`,
      ),
      // Cevapsız: her numaranın en son araması + retry count
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (data->>'customerPhone')
             data,
             (data->>'customerPhone') AS phone
           FROM calls
           ORDER BY data->>'customerPhone', start_time DESC NULLS LAST
         ),
         retry_counts AS (
           SELECT (data->>'customerPhone') AS phone, COUNT(*)::int AS cnt
           FROM calls
           WHERE status IN ('no-answer','busy')
           GROUP BY phone
         )
         SELECT l.data, COALESCE(r.cnt, 1) AS retry_count
         FROM latest l
         LEFT JOIN retry_counts r ON r.phone = l.phone
         WHERE l.data->>'status' IN ('no-answer','busy')
         ORDER BY retry_count ASC, (l.data->>'startTime') DESC`,
      ),
    ]);

    const ilgiRank: Record<string, number> = { yüksek: 3, orta: 2, düşük: 1, yok: 0 };
    const byIlgi = (a: any, b: any) =>
      (ilgiRank[b.summary?.ilgi_seviyesi ?? 'yok'] ?? 0) -
      (ilgiRank[a.summary?.ilgi_seviyesi ?? 'yok'] ?? 0);

    return res.json({
      success: true,
      data: {
        randevuAlanlar:  randevuRes.rows.map(r => r.data),
        geriAranacaklar: geriRes.rows.map(r => r.data).sort(byIlgi),
        beklemeListesi:  beklemeRes.rows.map(r => r.data).sort(byIlgi),
        manuelTakip:     manuelRes.rows.map(r => r.data).sort(byIlgi),
        cevapsizilar:    cevapsiziRes.rows.map(r => ({ ...r.data, retryCount: Number(r.retry_count) })),
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
    const scenarioPrompt = await resolveScenarioPromptForSummary(record);
    const summary = await generateCallSummary(record.customerInfo, history, scenarioPrompt);
    await saveCallSummary(vapiCallId, summary);
    return res.json({ success: true, data: summary });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── İSTATİSTİK ──────────────────────────────────────────────────────────────

app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    const period = req.query.period ? parseInt(String(req.query.period), 10) : undefined;
    return res.json({ success: true, data: await getStats(period && period > 0 ? period : undefined) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Kredi / abonelik bilgisi (Vapi + ElevenLabs) ─────────────────────────────
app.get('/api/credits', async (_req: Request, res: Response) => {
  const [vapi, elevenlabs] = await Promise.all([
    getVapiCredit(),
    getElevenLabsCredit(),
  ]);
  return res.json({ success: true, data: { vapi, elevenlabs } });
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

// Vapi'deki canlı (base) asistan promptu — tüm senaryosuz aramalarda kullanılan varsayılan prompt
app.get('/api/vapi/assistant-prompt', async (_req, res) => {
  try { return res.json({ success: true, data: await getAssistantSystemPrompt() }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/vapi/assistant-prompt', async (req, res) => {
  try {
    const { systemPrompt } = req.body as { systemPrompt: string };
    if (!systemPrompt?.trim())
      return res.status(400).json({ success: false, error: 'Prompt zorunlu' });
    await updateAssistantSystemPrompt(systemPrompt.trim());
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// AI ile Vapi sistem promptu üret — Vapi'nin public API'sinde bu özellik
// olmadığı için (doğrulandı) kendi Anthropic entegrasyonumuzla sağlanıyor.
app.post('/api/prompt/generate', async (req: Request, res: Response) => {
  try {
    const input = req.body as PromptGenInput;
    if (!input.companyName?.trim() || !input.callGoal?.trim()) {
      return res.status(400).json({ success: false, error: 'Şirket/marka adı ve aramanın amacı zorunlu' });
    }
    const systemPrompt = await generateVapiPrompt(input);
    return res.json({ success: true, data: { systemPrompt } });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── KAMPANYA GEÇMİŞİ — kalıcı kayıtlar + kampanya-bazlı analiz ──────────────

app.get('/api/campaigns', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await listCampaigns() });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.get('/api/campaigns/:id', async (req: Request, res: Response) => {
  try {
    const campaign = await getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Kampanya bulunamadı' });
    const stats = await getCampaignStats(req.params.id);
    return res.json({ success: true, data: { campaign, stats } });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── KAMPANYA — Sunucu taraflı çalışır (canlı dialer) ────────────────────────

app.get('/api/campaign', (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: getCampaignState() });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Kişi listesini yükle (henüz başlatma)
app.post('/api/campaign/load', async (req: Request, res: Response) => {
  try {
    const { contacts, maxConcurrent, scenarioId, name } = req.body;
    if (!Array.isArray(contacts) || !contacts.length)
      return res.status(400).json({ success: false, error: 'Kişi listesi zorunlu' });
    await campaignLoad(contacts, maxConcurrent || 1, scenarioId, undefined, undefined, undefined, name);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign/start', async (req: Request, res: Response) => {
  try {
    const { contacts, maxConcurrent, scenarioId, startFromIndex, callLimit, answeredLimit, name } = req.body;
    if (contacts?.length) {
      if (!name?.trim())
        return res.status(400).json({ success: false, error: 'Kampanya adı zorunlu' });
      await campaignLoad(
        contacts, maxConcurrent || 1, scenarioId,
        startFromIndex || 0, callLimit || 0, answeredLimit || 0, name,
      );
    }
    await campaignStart();
    return res.json({ success: true, data: getCampaignState() });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/calls/before-today', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `DELETE FROM calls WHERE start_time < CURRENT_DATE RETURNING vapi_call_id`,
    );
    return res.json({ success: true, deleted: result.rowCount ?? 0 });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/campaign/resume', async (_req: Request, res: Response) => {
  try {
    await campaignResume();
    return res.json({ success: true, data: getCampaignState() });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign/pause', async (_req: Request, res: Response) => {
  try {
    const result = await campaignPause();
    return res.json({ success: true, ...result });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign/stop', async (_req: Request, res: Response) => {
  try {
    await campaignStop();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/campaign', async (_req: Request, res: Response) => {
  try {
    await campaignClear();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── BAŞLAT ──────────────────────────────────────────────────────────────────

initDb()
  .then(async () => {
    initCampaignRunner(broadcast);
    await loadCampaignFromDb();
    const [anthropicKey, vapiKey] = await Promise.all([
      getSetting('ANTHROPIC_API_KEY'),
      getSetting('VAPI_API_KEY'),
    ]);
    app.listen(Number(PORT), HOST, () => {
      console.log(`\n✅ PropCall AI sunucusu başlatıldı`);
      console.log(`   → http://${HOST}:${PORT}`);
      console.log(`   → Anthropic: ${anthropicKey ? '✓' : '✗ (Admin panelden ekleyin: /admin)'}`);
      console.log(`   → Vapi:      ${vapiKey ? '✓' : '✗ (Admin panelden ekleyin: /admin)'}`);
      console.log(`   → Database:  ${process.env.DATABASE_URL ? '✓' : '✗'}\n`);
    });
  })
  .catch(err => {
    console.error('❌ Veritabanı başlatılamadı:', err);
    process.exit(1);
  });
