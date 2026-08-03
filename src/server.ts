import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { initDb } from './db';
import pool from './db';
import {
  handleGoogleLogin, handleGoogleCallback, handleLogout,
  requireAuth, requireAdmin, attachUser,
} from './auth';
import {
  getUserById, setUserVapiCredentials, setUserElevenLabsCredentials,
  markOnboardingComplete, listUsers, setUserActive, setUserRole,
} from './users';
import { generateCallSummary } from './ai';
import { createVapiCall, endVapiCall, getVapiCredit } from './vapi';
import { getElevenLabsCredit } from './elevenlabs';
import { getAllAppointments, saveAppointment, deleteAppointment } from './appointments';
import { getAllScenarios, getScenario, createScenario, updateScenario, deleteScenario } from './scenarios';
import {
  getAllCalls, readCall, createCall, updateCall,
  appendTranscript, updateCosts, saveCallSummary,
  endedReasonToStatus, getStats, exportCSV,
} from './calls';
import { VapiCallRequest, VapiWebhookPayload, VapiCostItem, CallFilters } from './types';
import {
  initCampaignRunner, loadCampaignFromDb, getCampaignState,
  campaignLoad, campaignStart, campaignResume, campaignPause, campaignStop, campaignClear,
  onCampaignCallEnded, onCampaignSummaryReady,
} from './campaign';

const app  = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// ─── Auth Routes (public) ─────────────────────────────────────────────────
app.get ('/auth/google',          handleGoogleLogin);
app.get ('/auth/google/callback', handleGoogleCallback);
app.post('/auth/logout',          handleLogout);
app.get ('/auth/logout',          handleLogout);

// Login sayfası (public static)
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Onboarding sayfası — auth gerektirir
app.get('/onboarding', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'onboarding.html'));
});

// Kullanıcı meta bilgisi (frontend için)
app.get('/api/me', attachUser, (req, res) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'not_authenticated' });
    return;
  }
  const u = req.user;
  res.json({
    success: true,
    data: {
      id: u.id, email: u.email, name: u.name, pictureUrl: u.picture_url,
      role: u.role,
      onboardingCompleted: u.onboarding_completed,
      hasVapi: !!u.vapi_assistant_id,
      hasElevenLabs: !!u.elevenlabs_voice_id,
    },
  });
});

// Static asset'ler — auth gerekmez (CSS/JS/img). login.html, onboarding.html public.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Onboarding API (auth arkasında) ──────────────────────────────────────
import {
  verifyVapiKey, listVapiPhoneNumbers, listVapiAssistants,
  createVapiAssistantFromTemplate, updateVapiAssistantServer,
} from './vapi';

const APP_URL_BASE = process.env.APP_URL || `http://localhost:${PORT}`;

// Step 1: Vapi API key doğrula
app.post('/api/onboarding/vapi/verify', requireAuth, async (req, res) => {
  try {
    const { apiKey } = req.body as { apiKey: string };
    if (!apiKey) return res.status(400).json({ success: false, error: 'apiKey zorunlu' });
    const info = await verifyVapiKey(apiKey);
    if (!info.ok) return res.status(400).json({ success: false, error: info.error });
    // Key'i geçici olarak sakla (henüz assistant seçilmemiş)
    await setUserVapiCredentials(req.userId!, { apiKey });
    return res.json({ success: true, data: info });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Step 2: Telefon + asistan listelerini getir
app.get('/api/onboarding/vapi/resources', requireAuth, async (req, res) => {
  try {
    const { getUserVapiApiKey } = await import('./users');
    const key = await getUserVapiApiKey(req.userId!);
    if (!key) return res.status(400).json({ success: false, error: 'Önce Vapi API key ekleyin' });
    const [phones, assistants] = await Promise.all([
      listVapiPhoneNumbers(key).catch(() => []),
      listVapiAssistants(key).catch(() => []),
    ]);
    return res.json({ success: true, data: { phones, assistants } });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Step 3a: Yeni asistan yarat (template'ten)
app.post('/api/onboarding/vapi/assistant/create', requireAuth, async (req, res) => {
  try {
    const { getUserVapiApiKey } = await import('./users');
    const key = await getUserVapiApiKey(req.userId!);
    if (!key) return res.status(400).json({ success: false, error: 'Önce Vapi API key ekleyin' });
    const assistant = await createVapiAssistantFromTemplate(key, {
      name: `PropCall - ${req.user!.name || req.user!.email}`,
      serverUrl: `${APP_URL_BASE}/webhook/${req.userId}`,
    });
    await setUserVapiCredentials(req.userId!, { assistantId: assistant.id });
    return res.json({ success: true, data: assistant });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Step 3b: Mevcut asistanı bağla (webhook URL'sini set eder)
app.post('/api/onboarding/vapi/assistant/link', requireAuth, async (req, res) => {
  try {
    const { assistantId } = req.body as { assistantId: string };
    if (!assistantId) return res.status(400).json({ success: false, error: 'assistantId zorunlu' });
    const { getUserVapiApiKey } = await import('./users');
    const key = await getUserVapiApiKey(req.userId!);
    if (!key) return res.status(400).json({ success: false, error: 'Önce Vapi API key ekleyin' });
    await updateVapiAssistantServer(key, assistantId, {
      serverUrl: `${APP_URL_BASE}/webhook/${req.userId}`,
    });
    await setUserVapiCredentials(req.userId!, { assistantId });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Step 4: Telefon numarası seç
app.post('/api/onboarding/vapi/phone', requireAuth, async (req, res) => {
  try {
    const { phoneNumberId } = req.body as { phoneNumberId: string };
    if (!phoneNumberId) return res.status(400).json({ success: false, error: 'phoneNumberId zorunlu' });
    await setUserVapiCredentials(req.userId!, { phoneNumberId });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Step 5 (opsiyonel): ElevenLabs
app.post('/api/onboarding/elevenlabs', requireAuth, async (req, res) => {
  try {
    const { apiKey, voiceId } = req.body as { apiKey?: string; voiceId?: string };
    await setUserElevenLabsCredentials(req.userId!, { apiKey, voiceId });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Onboarding tamamlandı
app.post('/api/onboarding/complete', requireAuth, async (req, res) => {
  try {
    const u = await getUserById(req.userId!);
    if (!u?.vapi_assistant_id || !u?.vapi_phone_number_id) {
      return res.status(400).json({ success: false, error: 'Vapi kurulumu eksik' });
    }
    await markOnboardingComplete(req.userId!);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
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

async function getUserVapiCreds(userId: string) {
  const { getUserVapiApiKey } = await import('./users');
  const u = await getUserById(userId);
  const apiKey = await getUserVapiApiKey(userId);
  if (!u || !apiKey || !u.vapi_assistant_id || !u.vapi_phone_number_id) {
    throw new Error('Vapi kurulumu eksik — Ayarlar\'dan tamamlayın');
  }
  return { apiKey, assistantId: u.vapi_assistant_id, phoneNumberId: u.vapi_phone_number_id };
}

app.post('/api/call', requireAuth, async (req: Request, res: Response) => {
  try {
    const { customer, scenarioId } = req.body as VapiCallRequest;
    if (!customer?.name || !customer?.phone)
      return res.status(400).json({ success: false, error: 'Ad ve telefon zorunlu' });

    const scenario = scenarioId ? await getScenario(req.userId!, scenarioId) : null;
    const creds    = await getUserVapiCreds(req.userId!);
    const vapiCall = await createVapiCall(creds, customer, scenario?.systemPrompt);
    const record   = await createCall(req.userId!, vapiCall.id, customer, scenario?.id, scenario?.name);

    console.log(`[Vapi] Arama başlatıldı: ${vapiCall.id} → ${customer.phone} (user: ${req.userId})`);
    return res.json({ success: true, data: { callId: vapiCall.id, recordId: record.callId } });
  } catch (err) {
    console.error('[API] /call hatası:', err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.delete('/api/call/:vapiCallId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { getUserVapiApiKey } = await import('./users');
    const key = await getUserVapiApiKey(req.userId!);
    if (!key) return res.status(400).json({ success: false, error: 'Vapi key yok' });
    // Sadece kendi araması ise sonlandırabilir
    const { getCallOwnerUserId } = await import('./calls');
    const owner = await getCallOwnerUserId(req.params.vapiCallId);
    if (owner !== req.userId) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    await endVapiCall(key, req.params.vapiCallId);
    await updateCall(req.params.vapiCallId, { status: 'completed', endTime: new Date().toISOString() });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── VAPI: Webhook ────────────────────────────────────────────────────────────
// Multi-tenant: /webhook/:userId — Vapi assistant serverUrl'inde userId var

app.post('/webhook/:userId', async (req: Request, res: Response) => {
  res.sendStatus(200);
  const routeUserId = req.params.userId;
  const payload = req.body as VapiWebhookPayload;

  // Anti-spoof: payload'daki assistantId → gerçekten bu user'ın assistant'ı mı?
  const assistantId = (payload?.message?.call as any)?.assistantId;
  if (assistantId) {
    const owner = await getUserById(routeUserId);
    if (!owner || owner.vapi_assistant_id !== assistantId) {
      console.warn(`[Webhook] SPOOF ATTEMPT: userId=${routeUserId} assistantId=${assistantId} — reject`);
      return;
    }
  }
  handleWebhook(payload, routeUserId).catch(console.error);
});

// Legacy webhook (mevcut kullanıcılar için — user_id assistantId'den bulunur)
app.post('/webhook', async (req: Request, res: Response) => {
  res.sendStatus(200);
  const payload = req.body as VapiWebhookPayload;
  const assistantId = (payload?.message?.call as any)?.assistantId;
  if (!assistantId) return;
  // Assistant ID'den user'ı bul
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE vapi_assistant_id = $1 LIMIT 1', [assistantId],
  );
  const userId = rows[0]?.id;
  if (!userId) {
    console.warn(`[Webhook /] Bilinmeyen assistantId=${assistantId}`);
    return;
  }
  handleWebhook(payload, userId).catch(console.error);
});

async function handleWebhook(payload: VapiWebhookPayload, userId?: string): Promise<void> {
  const msg = payload?.message;
  if (!msg?.type) return;

  const vapiCallId = msg.call?.id;
  console.log(`[Webhook] ${msg.type}${vapiCallId ? ` | ${vapiCallId}` : ''}${userId ? ` | user=${userId}` : ''}`);

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
      const newCosts  = parseCosts(msg.costs, msg.cost);

      console.log(`[Webhook] end-of-call-report → endedReason: "${endReason}" → status: "${status}" | süre: ${duration ?? '?'}s`);

      // Mevcut kaydı bir kez oku — transcript karşılaştırma + cost merge için
      const existing = await readCall(vapiCallId);
      const existingTranscriptLen = existing?.transcript?.length ?? 0;

      // Transcript: Artifact, streaming'den daha fazla geçerli mesaj içeriyorsa güncelle.
      // Aksi takdirde gerçek zamanlı gelen streaming transcript korunur.
      if (msg.artifact?.messages?.length) {
        const validMessages = (msg.artifact.messages as any[]).filter(m => {
          if (m.role !== 'assistant' && m.role !== 'user') return false;
          const text: string = m.message || m.content || m.text || '';
          return text.trim().length > 0;
        });

        if (validMessages.length > existingTranscriptLen) {
          await updateCall(vapiCallId, { transcript: [] } as any);
          for (const m of validMessages) {
            const text: string = m.message || m.content || m.text || '';
            await appendTranscript(vapiCallId, {
              role: m.role as 'assistant' | 'user',
              text,
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
      const newReason   = msg.call?.endedReason;
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
    const summary = await generateCallSummary(record.customerInfo, history);
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

app.get('/api/calls', requireAuth, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId } = req.query as Record<string, string>;
    const filters: CallFilters = { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId };
    return res.json({ success: true, data: await getAllCalls(req.userId!, filters) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/api/calls/:id', requireAuth, async (req: Request, res: Response) => {
  const { readCallForUser } = await import('./calls');
  const record = await readCallForUser(req.userId!, req.params.id);
  if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
  return res.json({ success: true, data: record });
});

app.patch('/api/calls/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { notes, followUp } = req.body as { notes?: string; followUp?: boolean };
    const updates: Record<string, unknown> = {};
    if (notes    !== undefined) updates.notes    = notes;
    if (followUp !== undefined) updates.followUp = followUp;
    const { updateCallForUser } = await import('./calls');
    const record = await updateCallForUser(req.userId!, req.params.id, updates as any);
    if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    return res.json({ success: true, data: record });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/generate-summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const { vapiCallId } = req.body as { vapiCallId: string };
    const { readCallForUser } = await import('./calls');
    const record = await readCallForUser(req.userId!, vapiCallId);
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

app.get('/api/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const period = req.query.period ? parseInt(String(req.query.period), 10) : undefined;
    return res.json({ success: true, data: await getStats(req.userId!, period && period > 0 ? period : undefined) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Kredi / abonelik bilgisi (kişinin kendi Vapi + ElevenLabs) ──────────────
app.get('/api/credits', requireAuth, async (req: Request, res: Response) => {
  const { getUserVapiApiKey, getUserElevenLabsApiKey } = await import('./users');
  const [vapiKey, elKey] = await Promise.all([
    getUserVapiApiKey(req.userId!),
    getUserElevenLabsApiKey(req.userId!),
  ]);
  const [vapi, elevenlabs] = await Promise.all([
    getVapiCredit(vapiKey || undefined),
    getElevenLabsCredit(elKey || undefined),
  ]);
  return res.json({ success: true, data: { vapi, elevenlabs } });
});

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────

app.get('/api/export', requireAuth, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId } = req.query as Record<string, string>;
    const filters: CallFilters = { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId };
    const csv = await exportCSV(req.userId!, filters);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="propcall-export.csv"' });
    return res.send('﻿' + csv);
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── RANDEVULAR ──────────────────────────────────────────────────────────────

app.get('/api/appointments', requireAuth, async (req, res) => {
  try { return res.json({ success: true, data: await getAllAppointments(req.userId!) }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/appointments', requireAuth, async (req, res) => {
  try {
    const { customerName, customerPhone, date, time, address, notes } = req.body;
    if (!customerName || !date || !time)
      return res.status(400).json({ success: false, error: 'Ad, tarih ve saat zorunlu' });
    return res.status(201).json({ success: true, data: await saveAppointment(req.userId!, { customerName, customerPhone, date, time, address, notes }) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/appointments/:id', requireAuth, async (req, res) => {
  try {
    if (!await deleteAppointment(req.userId!, req.params.id))
      return res.status(404).json({ success: false, error: 'Randevu bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── SENARYOLAR ──────────────────────────────────────────────────────────────

app.get('/api/scenarios', requireAuth, async (req, res) => {
  try { return res.json({ success: true, data: await getAllScenarios(req.userId!) }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/scenarios', requireAuth, async (req, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    if (!name || !systemPrompt)
      return res.status(400).json({ success: false, error: 'Ad ve prompt zorunlu' });
    return res.status(201).json({ success: true, data: await createScenario(req.userId!, name, systemPrompt) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/scenarios/:id', requireAuth, async (req, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    const updated = await updateScenario(req.userId!, req.params.id, name, systemPrompt);
    if (!updated) return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true, data: updated });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/scenarios/:id', requireAuth, async (req, res) => {
  try {
    if (!await deleteScenario(req.userId!, req.params.id))
      return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── KAMPANYA — Sunucu taraflı çalışır ───────────────────────────────────────

app.get('/api/campaign', (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: getCampaignState() });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Kişi listesini yükle (henüz başlatma)
app.post('/api/campaign/load', async (req: Request, res: Response) => {
  try {
    const { contacts, maxConcurrent, scenarioId } = req.body;
    if (!Array.isArray(contacts) || !contacts.length)
      return res.status(400).json({ success: false, error: 'Kişi listesi zorunlu' });
    await campaignLoad(contacts, maxConcurrent || 1, scenarioId);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign/start', async (req: Request, res: Response) => {
  try {
    const { contacts, maxConcurrent, scenarioId, startFromIndex, callLimit, answeredLimit } = req.body;
    if (contacts?.length) {
      await campaignLoad(
        contacts, maxConcurrent || 1, scenarioId,
        startFromIndex || 0, callLimit || 0, answeredLimit || 0,
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
