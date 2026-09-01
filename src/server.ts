import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

import { initDb } from './db';
import pool from './db';
import { generateCallSummary } from './ai';
import {
  createVapiCall, endVapiCall, getVapiCredit, getAssistantSystemPrompt, updateAssistantSystemPrompt,
  getSignedRecordingUrl, verifyVapiApiKey, getAssistantConfig, updateAssistantConfig, updateAssistantServer,
  listAssistants, listPhoneNumbers, importAssistant, AssistantConfigPatch,
} from './vapi';
import { getElevenLabsCredit, listElevenLabsVoices, estimateTtsCost, generateVoicePreview } from './elevenlabs';
import { getAllAppointments, saveAppointment, deleteAppointment, setAppointmentOutcome } from './appointments';
import { getAllScenarios, getScenario, createScenario, updateScenario, deleteScenario, seedDefaultScenario } from './scenarios';
import {
  getAllCalls, readCall, readCallForUser, createCall, updateCall, updateCallForUser,
  appendTranscript, updateCosts, saveCallSummary, getCallOwnerUserId,
  endedReasonToStatus, getStats, exportCSV, getCampaignStats, reconcileStaleCalls, getAdminUserComparison,
} from './calls';
import { VapiCallRequest, VapiWebhookPayload, VapiCostItem, CallFilters, CallRecord, CallCosts } from './types';
import {
  initCampaignRunner, loadAllActiveCampaigns, getCampaignState,
  campaignLoad, campaignStart, campaignResume, campaignPause, campaignStop, campaignClear,
  onCampaignCallEnded, onCampaignSummaryReady,
} from './campaign';
import { listCampaigns, getCampaign } from './campaigns';
import {
  ensureBootstrapAdmin, backfillOwnerlessRows, getSettingsForUser,
  listUsers, createUser, setUserActive, setUserPassword, setUserMaxConcurrent, setUserCallingHours,
  setUserElevenLabsRate, setUserVapiCredentials, setUserElevenLabsKey, setUserAnthropicKey,
  getUserVapiCredentials, getUserElevenLabsKey, getUserAnthropicKey, resolveVapiCreds, getUserById,
  getUserBalance, adjustUserBalance, chargeForCall, listCreditTransactions, CALL_MINUTE_RATE_TRY,
  setUserCompanyName, createPendingFonzipTopup, creditFonzipTopup,
} from './users';
import {
  isFonzipConfigured, resolveFonzipUserId, createTopupDebt, generateTopupLink,
  getDebtAmount, getDebtDetails, verifyWebhookAuthToken, ensureWebhookRegistered,
  findPendingTopup, cleanupStalePendingTopups,
} from './fonzip';
import { hashPassword, login, logout, getSessionUser, requireUserAuth, requireAdmin } from './auth';
import { generateVapiPrompt, PromptGenInput } from './promptgen';
import { getScriptRules, setScriptRules, lintGeneratedPrompt, rulesToSystemPromptAddendum } from './scriptRules';
import { simulateScenario } from './scenariotest';

const app  = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';
let httpServer: ReturnType<typeof app.listen> | undefined;

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── DANIŞMAN AUTH (e-posta + şifre) ─────────────────────────────────────────

app.post('/api/auth/login',  login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/session', getSessionUser);

app.get('/login', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ─── AYARLARIM — her danışman kendi Vapi/ElevenLabs/Anthropic bilgilerini yönetir ──

app.get('/api/settings', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const data = await getSettingsForUser(req.userId!);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Vapi bilgileri (apiKey + assistantId) tamamlanır tamamlanmaz webhook secret'ı
// üretip Vapi'nin assistant.server alanına yazar — böylece /webhook/:userId
// isteklerini doğrulayabiliriz (bkz. Faz 5 spoof kontrolü). Kaydetme akışını
// bloklamasın diye çağıran yer bunu fire-and-forget kullanır.
async function provisionWebhookIfReady(userId: string): Promise<void> {
  const creds = await getUserVapiCredentials(userId);
  if (!creds) return; // apiKey/phoneNumberId/assistantId üçlüsü henüz tam değil
  const appUrl = process.env.APP_URL;
  if (!appUrl) { console.warn('[Webhook] APP_URL tanımlı değil — otomatik webhook kurulumu atlandı'); return; }

  const secret = crypto.randomBytes(24).toString('base64url');
  await setUserVapiCredentials(userId, { serverSecret: secret });
  await updateAssistantServer(creds.apiKey, creds.assistantId, {
    url: `${appUrl}/webhook/${userId}`,
    secret,
  });
  console.log(`[Webhook] Otomatik kuruldu: userId=${userId} → ${appUrl}/webhook/${userId}`);
}

app.put('/api/settings', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { key, value } = req.body as { key: string; value: string };
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ success: false, error: 'Değer boş olamaz' });
    }
    const v = value.trim();
    switch (key) {
      case 'vapiApiKey':          await setUserVapiCredentials(req.userId!, { apiKey: v }); break;
      case 'vapiPublicKey':       await setUserVapiCredentials(req.userId!, { publicKey: v }); break;
      case 'vapiPhoneNumberId':   await setUserVapiCredentials(req.userId!, { phoneNumberId: v }); break;
      case 'vapiAssistantId':     await setUserVapiCredentials(req.userId!, { assistantId: v }); break;
      case 'elevenlabsApiKey':    await setUserElevenLabsKey(req.userId!, v); break;
      case 'anthropicApiKey':     await setUserAnthropicKey(req.userId!, v); break;
      case 'companyName':         await setUserCompanyName(req.userId!, v); break;
      default: return res.status(400).json({ success: false, error: 'Geçersiz anahtar' });
    }
    if (key === 'vapiApiKey' || key === 'vapiPhoneNumberId' || key === 'vapiAssistantId') {
      provisionWebhookIfReady(req.userId!).catch(err => console.warn('[Webhook] Otomatik kurulum hatası:', err));
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Kaydetmeden önce Vapi key'ini hızlıca doğrula
app.post('/api/settings/verify-vapi', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { value } = req.body as { value: string };
    if (!value?.trim()) return res.status(400).json({ success: false, error: 'Değer boş olamaz' });
    const result = await verifyVapiApiKey(value.trim());
    return res.json({ success: result.ok, error: result.error });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Kullanıcı yeni bir key yazdıysa onu, yazmadıysa (input boşsa) zaten kayıtlı
// key'ini kullanır — böylece hem ilk kurulumda ("Kaydet"e basmadan önce) hem de
// daha sonra ("key zaten kayıtlı, sadece asistanı değiştirmek istiyorum") çalışır.
async function resolveApiKeyForListing(req: Request): Promise<string> {
  const bodyKey = (req.body as { apiKey?: string })?.apiKey?.trim();
  if (bodyKey) return bodyKey;
  const creds = await getUserVapiCredentials(req.userId!);
  if (!creds) throw new Error('Vapi API Key girilmemiş');
  return creds.apiKey;
}

app.post('/api/settings/vapi-assistants', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const apiKey = await resolveApiKeyForListing(req);
    return res.json({ success: true, data: await listAssistants(apiKey) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/settings/vapi-phone-numbers', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const apiKey = await resolveApiKeyForListing(req);
    return res.json({ success: true, data: await listPhoneNumbers(apiKey) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Başka bir Vapi hesabındaki (kaynak) bir asistanın tam konfigürasyonunu, kendi
// (hedef) hesabında yepyeni bir asistan olarak oluşturur — model/ses/prompt/davranış
// hepsi kopyalanır, sadece webhook hedefin kendi hesabına göre ayrıca kurulur.
app.post('/api/settings/import-assistant', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { sourceApiKey, sourceAssistantId, newName } = req.body as {
      sourceApiKey: string; sourceAssistantId: string; newName?: string;
    };
    if (!sourceApiKey?.trim() || !sourceAssistantId?.trim()) {
      return res.status(400).json({ success: false, error: 'Kaynak Vapi API Key ve Assistant ID zorunlu' });
    }
    const targetCreds = await getUserVapiCredentials(req.userId!);
    if (!targetCreds) {
      return res.status(400).json({ success: false, error: 'Önce kendi Vapi API Key, Telefon Numarası ID bilgilerinizi kaydedin' });
    }

    const created = await importAssistant(sourceApiKey.trim(), sourceAssistantId.trim(), targetCreds.apiKey, newName);
    await setUserVapiCredentials(req.userId!, { assistantId: created.id });
    provisionWebhookIfReady(req.userId!).catch(err => console.warn('[Webhook] İçe aktarma sonrası otomatik kurulum hatası:', err));

    return res.json({ success: true, data: created });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── AYARLARIM — Arama saatleri + kişi başı eşzamanlı arama tavanı ──────────

app.get('/api/settings/calling-limits', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const user = await getUserById(req.userId!);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    return res.json({
      success: true,
      data: {
        maxConcurrentCalls: user.maxConcurrentCalls,
        callingHoursStart: user.callingHoursStart,
        callingHoursEnd: user.callingHoursEnd,
      },
    });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/settings/calling-limits', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { callingHoursStart, callingHoursEnd } = req.body as {
      callingHoursStart?: number | null; callingHoursEnd?: number | null;
    };
    const bothNull = callingHoursStart == null && callingHoursEnd == null;
    const bothSet  = callingHoursStart != null && callingHoursEnd != null
      && Number.isInteger(callingHoursStart) && Number.isInteger(callingHoursEnd)
      && callingHoursStart >= 0 && callingHoursStart <= 23 && callingHoursEnd >= 0 && callingHoursEnd <= 23;
    if (!bothNull && !bothSet) {
      return res.status(400).json({ success: false, error: 'Başlangıç ve bitiş saati ikisi birden 0-23 arası olmalı, ya da ikisi de boş bırakılmalı' });
    }
    await setUserCallingHours(req.userId!, callingHoursStart ?? null, callingHoursEnd ?? null);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── AYARLARIM — Maliyet takibi (ElevenLabs karakter başı ücret) ────────────
// Vapi'nin cost webhook'u BYO ElevenLabs'ta tts kalemini raporlamaz — kullanıcının
// kendi ElevenLabs planındaki gerçek $/1000-karakter oranını burada saklıyoruz,
// arama başına tahmini maliyet buna göre hesaplanıyor (bkz. generateSummaryForCall).

app.get('/api/settings/cost-config', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const user = await getUserById(req.userId!);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    return res.json({ success: true, data: { elevenLabsCostPer1k: user.elevenLabsCostPer1k } });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/settings/cost-config', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { elevenLabsCostPer1k } = req.body as { elevenLabsCostPer1k?: number | null };
    if (elevenLabsCostPer1k != null && (typeof elevenLabsCostPer1k !== 'number' || elevenLabsCostPer1k < 0)) {
      return res.status(400).json({ success: false, error: 'Geçersiz oran' });
    }
    await setUserElevenLabsRate(req.userId!, elevenLabsCostPer1k ?? null);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── AYARLARIM — Asistan Ayarları (model/ses/transkripsiyon/davranış) ────────

app.get('/api/settings/assistant-config', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const creds = await resolveVapiCreds(req.userId!);
    const data = await getAssistantConfig(creds.apiKey, creds.assistantId);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.put('/api/settings/assistant-config', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const creds = await resolveVapiCreds(req.userId!);
    const patch = req.body as AssistantConfigPatch;
    await updateAssistantConfig(creds.apiKey, creds.assistantId, patch);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/api/settings/elevenlabs-voices', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const key = await getUserElevenLabsKey(req.userId!);
    const data = await listElevenLabsVoices(key);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Danışmanın seçtiği sesi, KENDİ script metniyle seslendirip döner — API key
// sunucuda kalır, tarayıcı sadece ses baytlarını alır (audio/mpeg).
app.post('/api/settings/voice-preview', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { voiceId, text } = req.body as { voiceId?: string; text?: string };
    if (!voiceId?.trim() || !text?.trim()) {
      return res.status(400).json({ success: false, error: 'Ses ve metin zorunlu' });
    }
    const key = await getUserElevenLabsKey(req.userId!);
    const audio = await generateVoicePreview(key, voiceId.trim(), text);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(audio.length));
    return res.send(audio);
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/settings', requireUserAuth, (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'settings.html'));
});

// ─── ADMİN — Danışman (kullanıcı) yönetimi ───────────────────────────────────

app.get('/api/admin/users', requireAdmin, async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await listUsers() });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Danışmanlar arası (cross-tenant) karşılaştırma — sadece admin görebilir, tek bir
// danışmanın /api/stats'ından FARKLI: burada GROUP BY user_id, herkes bir arada.
app.get('/api/admin/stats', requireAdmin, async (req: Request, res: Response) => {
  try {
    const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
    const dateTo   = typeof req.query.dateTo   === 'string' ? req.query.dateTo   : undefined;
    const [rows, users] = await Promise.all([getAdminUserComparison(dateFrom, dateTo), listUsers()]);
    const userMap = new Map(users.map(u => [u.id, u]));
    const data = rows.map(r => ({
      ...r,
      email: userMap.get(r.userId)?.email ?? '—',
      name: userMap.get(r.userId)?.name ?? null,
    }));
    return res.json({ success: true, data });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Yeni danışman oluşturulduğunda mümkün olan her yeri firma varsayılanıyla doldurur —
// sadece telefon numarası danışmana özel kalır, o admin/danışman tarafından Ayarlarım'dan
// elle atanır. Hiçbir DEFAULT_* env değişkeni tanımlı değilse (henüz kurulmamışsa) sessizce
// atlanır — hesap oluşturmayı bloklamaz, alanlar mevcut akışta olduğu gibi boş kalır.
async function provisionNewUserDefaults(userId: string, name?: string, companyNameInput?: string): Promise<void> {
  try {
    const companyName = companyNameInput?.trim() || process.env.DEFAULT_COMPANY_NAME?.trim() || '';
    if (companyName) await setUserCompanyName(userId, companyName);

    const defVapiKey      = process.env.DEFAULT_VAPI_API_KEY?.trim();
    const defAssistantId  = process.env.DEFAULT_VAPI_ASSISTANT_ID?.trim();
    const defElevenKey    = process.env.DEFAULT_ELEVENLABS_API_KEY?.trim();
    const defAnthropicKey = process.env.DEFAULT_ANTHROPIC_API_KEY?.trim();

    if (defVapiKey)      await setUserVapiCredentials(userId, { apiKey: defVapiKey });
    if (defElevenKey)    await setUserElevenLabsKey(userId, defElevenKey);
    if (defAnthropicKey) await setUserAnthropicKey(userId, defAnthropicKey);

    if (defVapiKey && defAssistantId) {
      try {
        const created = await importAssistant(defVapiKey, defAssistantId, defVapiKey, name);
        await setUserVapiCredentials(userId, { assistantId: created.id });
      } catch (err) {
        console.warn(`[Onboarding] Varsayılan asistan klonlanamadı (userId=${userId}):`, err);
      }
    }
  } catch (err) {
    console.warn(`[Onboarding] Varsayılan kimlik bilgileri kopyalanamadı (userId=${userId}):`, err);
  }

  try {
    await seedDefaultScenario(userId);
  } catch (err) {
    console.warn(`[Onboarding] Varsayılan senaryo oluşturulamadı (userId=${userId}):`, err);
  }
}

app.post('/api/admin/users', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, name, password, role, companyName } = req.body as {
      email: string; name?: string; password: string; role?: 'agent' | 'admin'; companyName?: string;
    };
    if (!email?.trim() || !password?.trim()) {
      return res.status(400).json({ success: false, error: 'E-posta ve geçici şifre zorunlu' });
    }
    const user = await createUser({ email, name, passwordHash: hashPassword(password), role, companyName });
    await provisionNewUserDefaults(user.id, user.name || undefined, companyName);
    return res.status(201).json({ success: true, data: await getUserById(user.id) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.patch('/api/admin/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { isActive, password, maxConcurrentCalls } = req.body as {
      isActive?: boolean; password?: string; maxConcurrentCalls?: number;
    };
    if (isActive !== undefined) await setUserActive(req.params.id, isActive);
    if (password?.trim())      await setUserPassword(req.params.id, hashPassword(password));
    if (maxConcurrentCalls !== undefined) await setUserMaxConcurrent(req.params.id, maxConcurrentCalls);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Jeton (TL bakiyesi) yükleme/düzeltme — amount negatif de olabilir (hatalı
// yüklemeyi geri almak için). 1 jeton = 1 TL, dakika ücreti CALL_MINUTE_RATE_TRY.
app.post('/api/admin/users/:id/balance', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { amount, note } = req.body as { amount: number; note?: string };
    if (typeof amount !== 'number' || amount === 0 || !Number.isFinite(amount)) {
      return res.status(400).json({ success: false, error: 'Geçerli bir tutar girin (TL, 0 olamaz)' });
    }
    const type = amount > 0 ? 'topup' : 'adjustment';
    const newBalance = await adjustUserBalance(req.params.id, amount, type, note);
    return res.json({ success: true, data: { balanceTry: newBalance } });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.get('/admin', requireAdmin, (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ─── SSE — kullanıcı başına yayın (bir danışman başkasının canlı güncellemesini görmez) ──

const sseClients = new Map<string, Set<Response>>();

function broadcast(userId: string, event: string, data: unknown): void {
  const clients = sseClients.get(userId);
  if (!clients?.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => { try { c.write(msg); } catch { clients.delete(c); } });
}

app.get('/api/events', requireUserAuth, (req: Request, res: Response) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');

  const userId = req.userId!;
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId)!.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); sseClients.get(userId)?.delete(res); }
  }, 30000).unref();

  req.on('close', () => { clearInterval(heartbeat); sseClients.get(userId)?.delete(res); });
});

// ─── VAPI: Arama başlat ───────────────────────────────────────────────────────

app.post('/api/call', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { customer, scenarioId } = req.body as VapiCallRequest;
    if (!customer?.name || !customer?.phone)
      return res.status(400).json({ success: false, error: 'Ad ve telefon zorunlu' });

    const balance = await getUserBalance(req.userId!);
    if (balance < CALL_MINUTE_RATE_TRY) {
      return res.status(402).json({ success: false, error: `Jeton bakiyeniz yetersiz (kalan: ${balance.toFixed(2)} TL) — en az ${CALL_MINUTE_RATE_TRY} TL gerekli` });
    }

    const creds    = await resolveVapiCreds(req.userId!);
    const scenario = scenarioId ? await getScenario(req.userId!, scenarioId) : null;
    const user     = await getUserById(req.userId!);
    const vapiCall = await createVapiCall(creds, customer, scenario?.systemPrompt, {
      agentName: user?.name || undefined,
      companyName: user?.companyName || undefined,
    });
    const record   = await createCall(req.userId!, vapiCall.id, customer, scenario?.id, scenario?.name);

    console.log(`[Vapi] Arama başlatıldı: ${vapiCall.id} → ${customer.phone}`);
    return res.json({ success: true, data: { callId: vapiCall.id, recordId: record.callId } });
  } catch (err) {
    console.error('[API] /call hatası:', err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.delete('/api/call/:vapiCallId', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const owner = await getCallOwnerUserId(req.params.vapiCallId);
    if (owner !== req.userId) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    const creds = await resolveVapiCreds(req.userId!);
    await endVapiCall(creds.apiKey, req.params.vapiCallId);
    await updateCall(req.params.vapiCallId, { status: 'completed', endTime: new Date().toISOString() });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Ses kaydı: DB'deki ham recordingUrl HIPAA bucket'ında imzasız erişilemiyor —
// her istekte Vapi'den taze imzalı URL alıp tarayıcıyı oraya yönlendiriyoruz.
app.get('/api/calls/:vapiCallId/recording', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const owner = await getCallOwnerUserId(req.params.vapiCallId);
    if (owner !== req.userId) return res.status(404).json({ success: false, error: 'Kayıt bulunamadı' });
    const creds = await resolveVapiCreds(req.userId!);
    const url = await getSignedRecordingUrl(creds.apiKey, req.params.vapiCallId);
    if (!url) return res.status(404).json({ success: false, error: 'Kayıt bulunamadı' });
    return res.redirect(302, url);
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── VAPI: Webhook ────────────────────────────────────────────────────────────
// /webhook/:userId — birincil rota. Vapi'nin assistant.server ayarına
// provisionWebhookIfReady() tarafından otomatik yazılır. İki katmanlı doğrulama:
// (1) X-Vapi-Secret header, o kullanıcı için üretilmiş gizli anahtarla eşleşmeli
// (2) payload'daki assistantId, o kullanıcının kayıtlı assistantId'siyle eşleşmeli
// İkisi de tutmazsa istek sessizce (ama loglanarak) düşürülür — sahte istek başka
// bir danışmanın verisine yazamaz.
app.post('/webhook/:userId', async (req: Request, res: Response) => {
  res.sendStatus(200);
  const routeUserId = req.params.userId;
  const payload = req.body as VapiWebhookPayload;

  try {
    const creds = await getUserVapiCredentials(routeUserId);
    const secretHeader = req.get('X-Vapi-Secret') || '';
    const assistantId = (payload?.message?.call as any)?.assistantId;

    if (!creds || !creds.serverSecret || secretHeader !== creds.serverSecret) {
      console.warn(`[Webhook] SPOOF ATTEMPT (secret uyuşmuyor): userId=${routeUserId}`);
      return;
    }
    if (assistantId && assistantId !== creds.assistantId) {
      console.warn(`[Webhook] SPOOF ATTEMPT (assistantId uyuşmuyor): userId=${routeUserId} assistantId=${assistantId}`);
      return;
    }
  } catch (err) {
    console.error('[Webhook] Doğrulama hatası:', err);
    return;
  }

  trackWebhook(handleWebhook(payload).catch(console.error));
});

// Geriye dönük uyumluluk — henüz /webhook/:userId'ye taşınmamış eski assistant
// ayarları için. assistantId'den sahibi bulmaya çalışır, doğrulama yapmaz (zayıf).
// Her danışman Ayarlarım'dan Vapi bilgilerini kaydettiğinde otomatik olarak
// /webhook/:userId'ye geçer — bu rota zamanla kullanılmaz hale gelmeli.
app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);
  trackWebhook(handleWebhook(req.body as VapiWebhookPayload).catch(console.error));
});

// Fonzip ödeme bildirimi — kart ile jeton yükleme tamamlandığında gelir. Vapi
// webhook'undaki gibi hemen 200 dönülür (Fonzip'in retry etmemesi için) — hem
// başarı hem hata/sahtekarlık durumunda, bilgi sızdırmamak için.
app.post('/webhook/fonzip', async (req: Request, res: Response) => {
  res.sendStatus(200);
  try {
    const valid = await verifyWebhookAuthToken(req.header('X-FZ-Auth-Token'));
    if (!valid) {
      console.warn('[Fonzip Webhook] SPOOF ATTEMPT (auth token uyuşmuyor)');
      return;
    }

    const { id, operation, status } = req.body as { id?: number; operation?: number; status?: number };
    // operation 2 = Subscription (aidat/borç), status 3 = başarılı ödeme
    if (operation !== 2 || status !== 3 || !id) return;

    const amount = await getDebtAmount(id);
    if (amount == null) return;

    const result = await creditFonzipTopup(String(id), amount);
    if (result.credited && result.userId) {
      broadcast(result.userId, 'balance-update', { balanceTry: await getUserBalance(result.userId) });
      console.log(`[Fonzip] Jeton yüklendi: userId=${result.userId}, tutar=${amount} TL, debtId=${id}`);
    }
  } catch (err) {
    console.error('[Fonzip Webhook] Hata:', err);
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// Webhook'lar Vapi'ye hızlı yanıt vermek için hemen 200 dönüyor, DB yazımı
// (handleWebhook) arka planda fire-and-forget devam ediyor. Bir deploy/restart
// TAM O ANDA gelirse, henüz DB'ye yazılmamış bir sonuç (örn. "tamamlandı") kaybolup
// gidiyordu — reboot sonrası o kişi hâlâ "bekliyor" görünüp TEKRAR aranıyordu.
// Gerçek olay: arka arkaya deploy'lar sırasında birkaç kişi 15dk arayla iki kez
// arandı, ikisi de "tamamlandı" olarak kapandı. Çözüm: kapanış sinyali gelince yeni
// bağlantı almayı durdur, devam eden webhook'ların bitmesini bekle, SONRA çık.
const inFlightWebhooks = new Set<Promise<unknown>>();
function trackWebhook(p: Promise<unknown>): void {
  inFlightWebhooks.add(p);
  p.finally(() => inFlightWebhooks.delete(p));
}

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} alındı — ${inFlightWebhooks.size} bekleyen webhook işlemi tamamlanana kadar bekleniyor...`);
  httpServer?.close();

  // Railway'in SIGTERM → SIGKILL arası tanıdığı süreden kısa tutulmalı, aksi halde
  // process zaten zorla öldürülür ve bu bekleme hiç işe yaramaz.
  const DRAIN_TIMEOUT_MS = 8_000;
  await Promise.race([
    Promise.allSettled([...inFlightWebhooks]),
    new Promise<void>(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
  ]);

  if (inFlightWebhooks.size > 0) {
    console.warn(`[Shutdown] ${inFlightWebhooks.size} işlem ${DRAIN_TIMEOUT_MS / 1000}sn içinde bitmedi, yine de kapatılıyor.`);
  } else {
    console.log('[Shutdown] Tüm işlemler tamamlandı, kapatılıyor.');
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

async function handleWebhook(payload: VapiWebhookPayload): Promise<void> {
  const msg = payload?.message;
  if (!msg?.type) return;

  const vapiCallId = msg.call?.id;
  console.log(`[Webhook] ${msg.type}${vapiCallId ? ` | ${vapiCallId}` : ''}`);

  // SSE yayını kullanıcı bazlı olduğu için aramanın sahibini bir kez çözüyoruz.
  const ownerId = vapiCallId ? await getCallOwnerUserId(vapiCallId) : null;
  const emit = (event: string, data: unknown) => { if (ownerId) broadcast(ownerId, event, data); };

  switch (msg.type) {

    case 'call-started':
      if (!vapiCallId) break;
      await updateCall(vapiCallId, { status: 'in-progress' });
      emit('call-started', { vapiCallId });
      break;

    case 'transcript':
      if (!vapiCallId || msg.transcriptType !== 'final' || !msg.transcript || !msg.role) break;
      const entry = { role: msg.role, text: msg.transcript, timestamp: new Date().toISOString() };
      await appendTranscript(vapiCallId, entry);
      emit('transcript', { vapiCallId, ...entry });
      break;

    case 'cost-update': {
      if (!vapiCallId) break;
      const costs = parseCosts(msg.costs, msg.cost);
      if (costs) {
        await updateCosts(vapiCallId, costs);
        emit('cost-update', { vapiCallId, costs });
      }
      break;
    }

    case 'end-of-call-report': {
      if (!vapiCallId) break;
      const endedAt   = msg.call?.endedAt || new Date().toISOString();
      const endReason = msg.endedReason || msg.call?.endedReason;
      const recording = msg.recordingUrl || msg.artifact?.recordingUrl;
      const newCosts  = parseCosts(msg.costs, msg.cost);

      // Mevcut kaydı bir kez oku — transcript karşılaştırma + cost merge için
      const existing = await readCall(vapiCallId);
      const existingTranscriptLen = existing?.transcript?.length ?? 0;

      // Vapi'nin kendi duration alanı güvenilir gelmiyor (neredeyse hiç dolu gelmiyor) —
      // başlangıç/bitiş saatlerinden hesaplayıp fallback kullanıyoruz. Bu değer artık
      // sadece istatistiklerde değil, dakika bazlı jeton ücretlendirmesinde de kullanılıyor,
      // bu yüzden güvenilir olması kritik.
      let duration = msg.call?.duration;
      if (!duration && existing?.startTime) {
        duration = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(existing.startTime).getTime()) / 1000));
      }

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

      emit('call-ended', { vapiCallId, endedReason: endReason, duration, status });
      // Kampanya kişi durumunu (arıyor→tamamlandı vb.) DB'ye yazan asıl mekanizma
      // budur — fire-and-forget bırakılırsa tam bu anda bir deploy/restart gelirse
      // yazım kaybolup kişi "bekliyor" görünmeye devam eder ve TEKRAR aranır (gerçek
      // olay: birkaç kişi arka arkaya deploy'lar sırasında iki kez arandı). handleWebhook
      // zaten trackWebhook() ile korunuyor — bunu await etmek onu da o korumanın içine alır.
      await onCampaignCallEnded(vapiCallId, status, duration).catch(console.error);
      generateSummaryForCall(vapiCallId).catch(console.error);

      // Jeton ücretlendirmesi — sadece gerçekten bağlanıp konuşulan aramalar için
      // (cevapsız/meşgul/hata durumlarında dakika ücreti alınmaz). chargeForCall
      // aynı vapiCallId için iki kez çağrılsa bile (webhook tekrarı) DB seviyesinde
      // korumalı, ikinci kez düşülmez.
      if (ownerId && status === 'completed' && duration && duration > 0) {
        try {
          const charged = await chargeForCall(ownerId, vapiCallId, duration);
          if (charged) broadcast(ownerId, 'balance-update', { balanceTry: await getUserBalance(ownerId) });
        } catch (err) {
          console.error('[Billing] Jeton ücretlendirme hatası:', err);
        }
      }
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
        emit('call-ended', { vapiCallId, endedReason: newReason, status: s2 });
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
  const c = { vapi: 0, twilio: 0, llm: 0, tts: 0, stt: 0, anthropic: 0, total: 0 };
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
  existing: CallCosts | undefined,
  incoming: { vapi: number; twilio: number; llm: number; tts: number; stt: number; total: number },
): CallCosts {
  // anthropic Vapi'nin raporunda hiç yer almaz (biz ayrıca hesaplıyoruz) — bu yüzden
  // her zaman existing'den korunmalı, aksi halde bir sonraki Vapi webhook'u (örn. tekrar
  // eden end-of-call-report) onu sessizce sıfırlardı. tts de aynı sebeple: Vapi BYO
  // ElevenLabs'ta 0 raporlar, bizim tahminimiz existing'de duruyorsa o korunur.
  const vapi      = incoming.vapi      || existing?.vapi      || 0;
  const twilio    = incoming.twilio    || existing?.twilio    || 0;
  const llm       = incoming.llm       || existing?.llm       || 0;
  const tts       = incoming.tts       || existing?.tts       || 0;
  const stt       = incoming.stt       || existing?.stt       || 0;
  const anthropic = existing?.anthropic || 0;
  // Toplamı alanlardan yeniden hesapla — iki farklı olayın raporladığı bağımsız
  // "total" değerlerinden max() almak yerine, gerçekten birleştirilen alanlarla tutarlı olur.
  const total = Math.round((vapi + twilio + llm + tts + stt + anthropic) * 1e6) / 1e6;
  return { vapi, twilio, llm, tts, stt, anthropic, total };
}

// Özet üretiminde kullanılacak gerçek senaryo promptunu çözer:
// 1) Arama özel bir senaryoya bağlıysa (lokal scenarios tablosu) → onun promptu
// 2) Değilse → Vapi'deki canlı (base) asistan promptu (cache'li, 5dk TTL)
// Böylece analiz kriterleri her zaman aramada GERÇEKTEN kullanılan script'e göre uyum sağlar.
async function resolveScenarioPromptForSummary(userId: string, record: CallRecord): Promise<string | null> {
  if (record.scenarioId) {
    try {
      const scenario = await getScenario(userId, record.scenarioId);
      if (scenario?.systemPrompt) return scenario.systemPrompt;
    } catch (err) {
      console.warn('[AI] Senaryo promptu alınamadı, Vapi canlı promptuna düşülüyor:', err);
    }
  }
  try {
    const creds = await getUserVapiCredentials(userId);
    if (!creds) return null;
    const { systemPrompt } = await getAssistantSystemPrompt(creds.apiKey, creds.assistantId);
    return systemPrompt || null;
  } catch (err) {
    console.warn('[AI] Vapi canlı asistan promptu alınamadı:', err);
    return null;
  }
}

// Özet (Claude) üretildikten sonra gerçek Anthropic maliyetini ve — asistanın
// konuştuğu karakter sayısından — tahmini ElevenLabs maliyetini kaydeder.
// tts sadece Vapi'nin hiç raporlamadığı (BYO ElevenLabs'ta hep 0 gelen) durumda
// dolduruluyor — Vapi gerçekten bir voice cost raporlarsa onun üzerine yazılmaz.
async function applyDerivedCosts(
  vapiCallId: string, ownerId: string, record: CallRecord, usage: { costUsd: number },
): Promise<void> {
  const patch: Partial<CallCosts> = { anthropic: usage.costUsd };
  if (!record.costs?.tts) {
    const owner = await getUserById(ownerId);
    const assistantChars = record.transcript
      .filter(t => t.role === 'assistant')
      .reduce((sum, t) => sum + t.text.length, 0);
    const ttsEstimate = estimateTtsCost(assistantChars, owner?.elevenLabsCostPer1k);
    if (ttsEstimate > 0) patch.tts = ttsEstimate;
  }
  await updateCosts(vapiCallId, patch);
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

  const ownerId = await getCallOwnerUserId(vapiCallId);
  if (!ownerId) { console.warn(`[AI] ${vapiCallId} sahibi bulunamadı, özet atlandı`); return; }

  try {
    const anthropicKey = await getUserAnthropicKey(ownerId);
    const history = record.transcript.map(t => ({ role: t.role, content: t.text }));
    const scenarioPrompt = await resolveScenarioPromptForSummary(ownerId, record);
    const { summary, usage } = await generateCallSummary(anthropicKey, record.customerInfo, history, scenarioPrompt);
    await saveCallSummary(vapiCallId, summary);
    await applyDerivedCosts(vapiCallId, ownerId, record, usage);
    broadcast(ownerId, 'summary-ready', { vapiCallId, summary });
    onCampaignSummaryReady(vapiCallId, summary).catch(console.error);
    console.log(`[AI] Özet hazır: ${vapiCallId} (Anthropic: $${usage.costUsd.toFixed(4)})`);
  } catch (err) {
    console.error('[AI] Özet hatası:', err);
    broadcast(ownerId, 'summary-error', { vapiCallId, error: String(err) });
  }
}

// ─── TAKİP LİSTESİ ───────────────────────────────────────────────────────────

app.get('/api/followup', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    // Her grup için yalnızca ilgili satırları çek — tüm tabloyu belleğe almak yerine SQL filtresi
    const [randevuRes, geriRes, beklemeRes, manuelRes, cevapsiziRes] = await Promise.all([
      pool.query(
        `SELECT data FROM calls
         WHERE user_id = $1 AND (data->'summary'->>'randevu_alindi')::boolean = true
         ORDER BY start_time DESC NULLS LAST`,
        [userId],
      ),
      pool.query(
        `SELECT data FROM calls
         WHERE user_id = $1 AND data->'summary'->>'tavsiye_edilen_aksiyon' = 'Ara'
           AND status != 'in-progress'
         ORDER BY start_time DESC NULLS LAST`,
        [userId],
      ),
      pool.query(
        `SELECT data FROM calls
         WHERE user_id = $1 AND data->'summary'->>'tavsiye_edilen_aksiyon' = 'Bekleme listesine al'
           AND status != 'in-progress'
         ORDER BY start_time DESC NULLS LAST`,
        [userId],
      ),
      pool.query(
        `SELECT data FROM calls
         WHERE user_id = $1 AND (data->>'followUp')::boolean = true
         ORDER BY start_time DESC NULLS LAST`,
        [userId],
      ),
      // Cevapsız: her numaranın en son araması + retry count (aynı kiracı içinde)
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (data->>'customerPhone')
             data,
             (data->>'customerPhone') AS phone
           FROM calls
           WHERE user_id = $1
           ORDER BY data->>'customerPhone', start_time DESC NULLS LAST
         ),
         retry_counts AS (
           SELECT (data->>'customerPhone') AS phone, COUNT(*)::int AS cnt
           FROM calls
           WHERE user_id = $1 AND status IN ('no-answer','busy')
           GROUP BY phone
         )
         SELECT l.data, COALESCE(r.cnt, 1) AS retry_count
         FROM latest l
         LEFT JOIN retry_counts r ON r.phone = l.phone
         WHERE l.data->>'status' IN ('no-answer','busy')
         ORDER BY retry_count ASC, (l.data->>'startTime') DESC`,
        [userId],
      ),
    ]);

    const ilgiRank: Record<string, number> = { yüksek: 3, orta: 2, düşük: 1, yok: 0 };
    const byIlgi = (a: any, b: any) =>
      (ilgiRank[b.summary?.ilgi_seviyesi ?? 'yok'] ?? 0) -
      (ilgiRank[a.summary?.ilgi_seviyesi ?? 'yok'] ?? 0);

    const manuelTakip     = manuelRes.rows.map(r => r.data).sort(byIlgi);
    const geriAranacaklar = geriRes.rows.map(r => r.data).sort(byIlgi);
    const cevapsizilar    = cevapsiziRes.rows.map(r => ({ ...r.data, retryCount: Number(r.retry_count) }));

    // "Bugün kimi aramalıyım" — üç ayrı listeyi (manuel/sıcak lead/cevapsız) TEK,
    // şeffaf skorlu sıralamada birleştirir. Skor sebep-görünür: kaynak ağırlığı +
    // ilgi seviyesi + (cevapsızlarda) deneme sayısı cezası. Aynı kişi (telefon)
    // birden fazla listede geçebilir — en yüksek skorlu görünümü tutulur.
    function priorityScore(c: any, source: string): number {
      let score = source === 'manuel' ? 100 : source === 'ara' ? 70 : 40;
      const ilgi = c.summary?.ilgi_seviyesi;
      if (ilgi === 'yüksek') score += 15;
      else if (ilgi === 'orta') score += 10;
      else if (ilgi === 'düşük') score += 5;
      if (source === 'cevapsiz' && c.retryCount) score -= Math.min(15, (c.retryCount - 1) * 5);
      return score;
    }

    const priorityCandidates = [
      ...manuelTakip.map(c => ({ c, source: 'manuel', label: 'Manuel Takip' })),
      ...geriAranacaklar.map(c => ({ c, source: 'ara', label: 'Sıcak Lead' })),
      ...cevapsizilar.map(c => ({ c, source: 'cevapsiz', label: (c as any).status === 'meşgul' ? 'Meşgul' : 'Cevapsız' })),
    ];

    const byPhone = new Map<string, any>();
    for (const { c, source, label } of priorityCandidates) {
      const score = priorityScore(c, source);
      const existing = byPhone.get(c.customerPhone);
      if (!existing || score > existing._priorityScore) {
        byPhone.set(c.customerPhone, { ...c, _prioritySource: source, _priorityLabel: label, _priorityScore: score });
      }
    }
    const oncelikliListe = Array.from(byPhone.values()).sort((a, b) => b._priorityScore - a._priorityScore);

    return res.json({
      success: true,
      data: {
        randevuAlanlar:  randevuRes.rows.map(r => r.data),
        geriAranacaklar,
        beklemeListesi:  beklemeRes.rows.map(r => r.data).sort(byIlgi),
        manuelTakip,
        cevapsizilar,
        oncelikliListe,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── ARAMALAR ─────────────────────────────────────────────────────────────────

app.get('/api/calls', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId } = req.query as Record<string, string>;
    const filters: CallFilters = { dateFrom, dateTo, randevu, ilgi, aksiyon, status, scenarioId };
    return res.json({ success: true, data: await getAllCalls(req.userId!, filters) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/api/calls/:id', requireUserAuth, async (req: Request, res: Response) => {
  const record = await readCallForUser(req.userId!, req.params.id);
  if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
  return res.json({ success: true, data: record });
});

app.patch('/api/calls/:id', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { notes, followUp } = req.body as { notes?: string; followUp?: boolean };
    const updates: Record<string, unknown> = {};
    if (notes    !== undefined) updates.notes    = notes;
    if (followUp !== undefined) updates.followUp = followUp;
    const record = await updateCallForUser(req.userId!, req.params.id, updates as any);
    if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    return res.json({ success: true, data: record });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/generate-summary', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { vapiCallId } = req.body as { vapiCallId: string };
    const record = await readCallForUser(req.userId!, vapiCallId);
    if (!record) return res.status(404).json({ success: false, error: 'Arama bulunamadı' });
    const anthropicKey = await getUserAnthropicKey(req.userId!);
    const history = record.transcript.map(t => ({ role: t.role, content: t.text }));
    const scenarioPrompt = await resolveScenarioPromptForSummary(req.userId!, record);
    const { summary, usage } = await generateCallSummary(anthropicKey, record.customerInfo, history, scenarioPrompt);
    await saveCallSummary(vapiCallId, summary);
    await applyDerivedCosts(vapiCallId, req.userId!, record, usage);
    return res.json({ success: true, data: summary });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── İSTATİSTİK ──────────────────────────────────────────────────────────────

app.get('/api/stats', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const dateFrom   = typeof req.query.dateFrom   === 'string' ? req.query.dateFrom   : undefined;
    const dateTo     = typeof req.query.dateTo     === 'string' ? req.query.dateTo     : undefined;
    const scenarioId = typeof req.query.scenarioId === 'string' ? req.query.scenarioId : undefined;
    return res.json({ success: true, data: await getStats(req.userId!, { dateFrom, dateTo, scenarioId }) });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Kredi / abonelik bilgisi (Vapi + ElevenLabs) ─────────────────────────────
app.get('/api/credits', requireUserAuth, async (req: Request, res: Response) => {
  const elevenlabsKey = await getUserElevenLabsKey(req.userId!);
  const [vapi, elevenlabs] = await Promise.all([
    getVapiCredit(),
    getElevenLabsCredit(elevenlabsKey),
  ]);
  return res.json({ success: true, data: { vapi, elevenlabs } });
});

// ─── JETON (TL bakiyesi) ──────────────────────────────────────────────────────
app.get('/api/billing', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const [balanceTry, transactions] = await Promise.all([
      getUserBalance(req.userId!),
      listCreditTransactions(req.userId!, 50),
    ]);
    return res.json({ success: true, data: { balanceTry, ratePerMinute: CALL_MINUTE_RATE_TRY, transactions, fonzipEnabled: isFonzipConfigured() } });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Kredi kartıyla kendi kendine jeton yükleme — Fonzip'te bir borç açar, danışmanı
// Fonzip'in kendi hosted ödeme sayfasına yönlendirecek linki döner. Kart bilgisi hiçbir
// zaman bize uğramaz; ödeme tamamlanınca bakiye POST /webhook/fonzip ile kredilenir.
const MIN_TOPUP_TRY = 50;
app.post('/api/billing/topup', requireUserAuth, async (req: Request, res: Response) => {
  try {
    if (!isFonzipConfigured()) {
      return res.status(400).json({ success: false, error: 'Kart ile yükleme şu an yapılandırılmamış' });
    }
    const { amount } = req.body as { amount: number };
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < MIN_TOPUP_TRY) {
      return res.status(400).json({ success: false, error: `En az ${MIN_TOPUP_TRY} TL girin` });
    }
    const user = await getUserById(req.userId!);
    if (!user?.email) return res.status(400).json({ success: false, error: 'Hesabınızda e-posta tanımlı değil' });

    const fonzipUserId = await resolveFonzipUserId(req.userId!, user.name || user.email, user.email);

    // Danışman aynı talebi tekrar açarsa (örn. bir önceki sekmeyi kapatıp tekrar denedi)
    // aynı tutar için ikinci bir borç açmak yerine mevcut bekleyen borcun linkini tekrar
    // ver — Fonzip kaydında gereksiz tekrarlanan borç birikmesin.
    let debtId: number | string | undefined;
    try {
      const pending = await findPendingTopup(req.userId!);
      if (pending) {
        const details = await getDebtDetails(pending.fonzipDebtId);
        if (details && details.status === 1 && details.amount === amount) {
          debtId = pending.fonzipDebtId;
        }
      }
    } catch (err) {
      console.warn('[Fonzip] Bekleyen borç kontrolü başarısız, yeni borç açılacak:', err);
    }
    if (!debtId) {
      debtId = await createTopupDebt(fonzipUserId, amount, `PropCall Jeton Yükleme — ${user.email}`);
      await createPendingFonzipTopup(req.userId!, String(debtId), amount);
    }
    const link = await generateTopupLink(fonzipUserId);

    return res.json({ success: true, data: { link } });
  } catch (err) {
    console.error('[Fonzip] Topup hatası:', err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────

app.get('/api/export', requireUserAuth, async (req: Request, res: Response) => {
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

app.get('/api/appointments', requireUserAuth, async (req: Request, res) => {
  try { return res.json({ success: true, data: await getAllAppointments(req.userId!) }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/appointments', requireUserAuth, async (req: Request, res) => {
  try {
    const { customerName, customerPhone, date, time, address, notes } = req.body;
    if (!customerName || !date || !time)
      return res.status(400).json({ success: false, error: 'Ad, tarih ve saat zorunlu' });
    return res.status(201).json({ success: true, data: await saveAppointment(req.userId!, { customerName, customerPhone, date, time, address, notes }) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/appointments/:id', requireUserAuth, async (req: Request, res) => {
  try {
    if (!await deleteAppointment(req.userId!, req.params.id))
      return res.status(404).json({ success: false, error: 'Randevu bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.patch('/api/appointments/:id/outcome', requireUserAuth, async (req: Request, res) => {
  try {
    const { outcome, outcomeNote } = req.body as { outcome?: string; outcomeNote?: string };
    if (outcome !== 'pending' && outcome !== 'won' && outcome !== 'lost')
      return res.status(400).json({ success: false, error: "outcome 'pending'|'won'|'lost' olmalı" });
    const updated = await setAppointmentOutcome(req.userId!, req.params.id, outcome, outcomeNote);
    if (!updated) return res.status(404).json({ success: false, error: 'Randevu bulunamadı' });
    return res.json({ success: true, data: updated });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── SENARYOLAR ──────────────────────────────────────────────────────────────

app.get('/api/scenarios', requireUserAuth, async (req: Request, res) => {
  try { return res.json({ success: true, data: await getAllScenarios(req.userId!) }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/scenarios', requireUserAuth, async (req: Request, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    if (!name || !systemPrompt)
      return res.status(400).json({ success: false, error: 'Ad ve prompt zorunlu' });
    return res.status(201).json({ success: true, data: await createScenario(req.userId!, name, systemPrompt) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/scenarios/:id', requireUserAuth, async (req: Request, res) => {
  try {
    const { name, systemPrompt } = req.body as { name: string; systemPrompt: string };
    const updated = await updateScenario(req.userId!, req.params.id, name, systemPrompt);
    if (!updated) return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true, data: updated });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/scenarios/:id', requireUserAuth, async (req: Request, res) => {
  try {
    if (!await deleteScenario(req.userId!, req.params.id))
      return res.status(404).json({ success: false, error: 'Senaryo bulunamadı' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Vapi'deki canlı (base) asistan promptu — tüm senaryosuz aramalarda kullanılan varsayılan prompt
app.get('/api/vapi/assistant-prompt', requireUserAuth, async (req: Request, res) => {
  try {
    const creds = await resolveVapiCreds(req.userId!);
    return res.json({ success: true, data: await getAssistantSystemPrompt(creds.apiKey, creds.assistantId) });
  }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/vapi/assistant-prompt', requireUserAuth, async (req: Request, res) => {
  try {
    const { systemPrompt } = req.body as { systemPrompt: string };
    if (!systemPrompt?.trim())
      return res.status(400).json({ success: false, error: 'Prompt zorunlu' });
    const creds = await resolveVapiCreds(req.userId!);
    await updateAssistantSystemPrompt(creds.apiKey, creds.assistantId, systemPrompt.trim());
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// AI ile Vapi sistem promptu üret — Vapi'nin public API'sinde bu özellik
// olmadığı için (doğrulandı) kendi Anthropic entegrasyonumuzla sağlanıyor.
app.post('/api/prompt/generate', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const input = req.body as PromptGenInput;
    const hasRaw = !!input.rawText?.trim();
    if (!hasRaw && (!input.companyName?.trim() || !input.callGoal?.trim())) {
      return res.status(400).json({ success: false, error: 'Şirket/marka adı ve aramanın amacı zorunlu (veya serbest metin girin)' });
    }
    const anthropicKey = await getUserAnthropicKey(req.userId!);
    const rules = await getScriptRules();
    const raw = await generateVapiPrompt(anthropicKey, input, rulesToSystemPromptAddendum(rules));
    // Son denetim — LLM kuralı gözden kaçırmış olsa bile burası deterministik son söz
    // sahibi: yasaklı ifadeler raporlanır (üretilen metinden silinmez, prompt yapısını
    // bozabilir), zorunlu açıklama eksikse otomatik eklenir.
    const lint = lintGeneratedPrompt(raw, rules);
    return res.json({
      success: true,
      data: { systemPrompt: lint.text, scriptWarnings: lint.violations, disclosureAdded: lint.disclosureAdded },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── ADMİN — Şirket geneli AI script kısıtlamaları ──────────────────────────
app.get('/api/admin/script-rules', requireAdmin, async (_req: Request, res: Response) => {
  try { return res.json({ success: true, data: await getScriptRules() }); }
  catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.put('/api/admin/script-rules', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { bannedPhrases, requiredDisclosure, forbidPriceCommitment } = req.body as {
      bannedPhrases?: string[]; requiredDisclosure?: string | null; forbidPriceCommitment?: boolean;
    };
    await setScriptRules({
      bannedPhrases: Array.isArray(bannedPhrases) ? bannedPhrases.filter(p => p?.trim()).map(p => p.trim()) : [],
      requiredDisclosure: requiredDisclosure?.trim() || null,
      forbidPriceCommitment: forbidPriceCommitment !== false,
    });
    return res.json({ success: true, data: await getScriptRules() });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Bir sistem promptunu gerçek para harcamadan (Vapi araması yapmadan) test et —
// Claude hem asistanı hem 3 farklı müşteri tepkisini simüle eder.
app.post('/api/prompt/simulate', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { systemPrompt, customerName } = req.body as { systemPrompt: string; customerName?: string };
    if (!systemPrompt?.trim()) {
      return res.status(400).json({ success: false, error: 'Sistem promptu zorunlu' });
    }
    const anthropicKey = await getUserAnthropicKey(req.userId!);
    const user = await getUserById(req.userId!);
    const scenarios = await simulateScenario(anthropicKey, systemPrompt, customerName, user?.name || undefined, user?.companyName || undefined);
    return res.json({ success: true, data: { scenarios } });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── KAMPANYA GEÇMİŞİ — kalıcı kayıtlar + kampanya-bazlı analiz ──────────────

app.get('/api/campaigns', requireUserAuth, async (req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await listCampaigns(req.userId!) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.get('/api/campaigns/:id', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const campaign = await getCampaign(req.userId!, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Kampanya bulunamadı' });
    const stats = await getCampaignStats(req.userId!, req.params.id);
    return res.json({ success: true, data: { campaign, stats } });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── KAMPANYA — Sunucu taraflı çalışır (canlı dialer) ────────────────────────
// NOT: motor hâlâ tek-kampanyalık singleton (Faz 4'te kampanya-başına eşzamanlı
// hale gelecek) — bu yüzden aşağıdaki rotalar geçici olarak "şu an yüklü kampanya
// benim mi" kontrolü yapıyor, tam izolasyon değil.

// NOT: frontend henüz kampanya seçici arayüzüne sahip değil — campaignId query/body'de
// verilmezse motor "kullanıcının en son etkileşimde bulunduğu kampanya"yı hedefler (bkz.
// campaign.ts:resolveEntry). Arka uç birden fazla eşzamanlı kampanyayı tam destekler;
// bu sadece bugünkü tek-odaklı arayüzle geriye dönük uyumluluk için.

app.get('/api/campaign', requireUserAuth, (req: Request, res: Response) => {
  try {
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
    return res.json({ success: true, data: getCampaignState(req.userId!, campaignId) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// Kişi listesini yükle (henüz başlatma) — mevcut çalışan kampanyaları etkilemez, yenisini ekler.
app.post('/api/campaign/load', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { contacts, maxConcurrent, scenarioId, name, retryMaxAttempts, retryDelayMinutes } = req.body;
    if (!Array.isArray(contacts) || !contacts.length)
      return res.status(400).json({ success: false, error: 'Kişi listesi zorunlu' });
    const campaignId = await campaignLoad(
      req.userId!, contacts, maxConcurrent || 1, scenarioId, undefined, undefined, undefined, name,
      retryMaxAttempts, retryDelayMinutes,
    );
    return res.json({ success: true, data: { campaignId } });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign/start', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { contacts, maxConcurrent, scenarioId, startFromIndex, callLimit, answeredLimit, name, retryMaxAttempts, retryDelayMinutes } = req.body;
    let campaignId: string | undefined = req.body.campaignId;
    if (contacts?.length) {
      if (!name?.trim())
        return res.status(400).json({ success: false, error: 'Kampanya adı zorunlu' });
      campaignId = await campaignLoad(
        req.userId!, contacts, maxConcurrent || 1, scenarioId,
        startFromIndex || 0, callLimit || 0, answeredLimit || 0, name,
        retryMaxAttempts, retryDelayMinutes,
      );
    }
    if (!campaignId) return res.status(400).json({ success: false, error: 'contacts veya campaignId gerekli' });
    await campaignStart(req.userId!, campaignId);
    return res.json({ success: true, data: getCampaignState(req.userId!, campaignId) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/calls/before-today', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `DELETE FROM calls WHERE start_time < CURRENT_DATE AND user_id = $1 RETURNING vapi_call_id`,
      [req.userId!],
    );
    return res.json({ success: true, deleted: result.rowCount ?? 0 });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/campaign/resume', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const { campaignId, startFromIndex, maxConcurrent, callLimit, answeredLimit, retryMaxAttempts, retryDelayMinutes } = req.body as {
      campaignId?: string; startFromIndex?: number; maxConcurrent?: number; callLimit?: number; answeredLimit?: number;
      retryMaxAttempts?: number; retryDelayMinutes?: number;
    };
    const overrides = { startFromIndex, maxConcurrent, callLimit, answeredLimit, retryMaxAttempts, retryDelayMinutes };
    const hasOverrides = Object.values(overrides).some(v => v !== undefined);
    await campaignResume(req.userId!, campaignId, hasOverrides ? overrides : undefined);
    return res.json({ success: true, data: getCampaignState(req.userId!, campaignId) });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign/pause', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId : undefined;
    const result = await campaignPause(req.userId!, campaignId);
    return res.json({ success: true, ...result });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.post('/api/campaign/stop', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId : undefined;
    await campaignStop(req.userId!, campaignId);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

app.delete('/api/campaign', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
    await campaignClear(req.userId!, campaignId);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── BAŞLAT ──────────────────────────────────────────────────────────────────

initDb()
  .then(async () => {
    const admin = await ensureBootstrapAdmin(hashPassword);
    const backfilled = await backfillOwnerlessRows(admin.id);
    const backfilledTotal = Object.values(backfilled).reduce((a, b) => a + b, 0);
    if (backfilledTotal > 0) {
      console.log(`[Bootstrap] Sahipsiz kayıtlar "${admin.email}" hesabına atandı:`, backfilled);
    }
    initCampaignRunner(broadcast);
    await loadAllActiveCampaigns();
    const staleCount = await reconcileStaleCalls();
    if (staleCount > 0) {
      console.log(`[Reconcile] ${staleCount} eski "in-progress" arama "failed" olarak kapatıldı (webhook gelmemişti)`);
    }

    // Vapi bilgileri tam ama henüz webhook secret'ı üretilmemiş kullanıcılar için
    // (örn. eski global ayarlardan taşınan bootstrap admin) otomatik kurulum tamamla.
    for (const u of await listUsers()) {
      const creds = await getUserVapiCredentials(u.id);
      if (creds && !creds.serverSecret) {
        await provisionWebhookIfReady(u.id).catch(err => console.warn(`[Webhook] ${u.email} otomatik kurulum hatası:`, err));
      }
    }

    if (isFonzipConfigured() && process.env.APP_URL) {
      ensureWebhookRegistered(`${process.env.APP_URL}/webhook/fonzip`)
        .catch(err => console.warn('[Fonzip] Webhook kaydı başarısız:', err));

      // Ödeme sayfasından vazgeçilip terk edilen (1 saatten eski, hâlâ ödenmemiş) borçları
      // düzenli tarayıp Fonzip'ten siler — kaçırılmış bir webhook varsa da burada
      // kendiliğinden düzeltilir. 20 dakikada bir yeterli, acil bir işlem değil.
      setInterval(() => {
        cleanupStalePendingTopups()
          .then(({ healedUserIds }) => {
            for (const uid of healedUserIds) {
              getUserBalance(uid).then(balanceTry => broadcast(uid, 'balance-update', { balanceTry })).catch(() => {});
            }
          })
          .catch(err => console.error('[Fonzip] Bekleyen yükleme temizliği hatası:', err));
      }, 20 * 60 * 1000).unref();
    }

    const adminSettings = await getSettingsForUser(admin.id);
    httpServer = app.listen(Number(PORT), HOST, () => {
      console.log(`\n✅ PropCall AI sunucusu başlatıldı`);
      console.log(`   → http://${HOST}:${PORT}`);
      console.log(`   → Admin (${admin.email}) — Anthropic: ${adminSettings.anthropicApiKey.hasValue ? '✓' : '✗'} | Vapi: ${adminSettings.vapiApiKey.hasValue ? '✓' : '✗'} (bkz. /settings)`);
      console.log(`   → Database:  ${process.env.DATABASE_URL ? '✓' : '✗'}\n`);
    });
  })
  .catch(err => {
    console.error('❌ Veritabanı başlatılamadı:', err);
    process.exit(1);
  });
