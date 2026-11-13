// PropCall AI - TypeScript tip tanımları

export interface CustomerInfo {
  name: string;
  phone: string;
  region: string;
  notes: string;
  reference: string;
}

export interface CallCosts {
  vapi: number;
  twilio: number;
  llm: number;
  tts: number;       // ElevenLabs — BYO key kullanıldığında Vapi bunu raporlamaz (her zaman 0
                      // döner), bu yüzden konuşulan karakter sayısından biz tahmin ediyoruz.
  stt: number;
  anthropic: number;  // Görüşme özeti (Claude) — gerçek token kullanımından hesaplanan gerçek maliyet.
  total: number;
}

export interface VapiTranscriptEntry {
  role: 'assistant' | 'user';
  text: string;
  timestamp: string;
}

export interface CallSummary {
  randevu_alindi: boolean;
  ilgi_seviyesi: 'yüksek' | 'orta' | 'düşük' | 'yok';
  ret_nedeni: string | null;
  mulk_tipi: string | null;
  ozet: string;
  tavsiye_edilen_aksiyon: 'Ara' | 'Bekleme listesine al' | 'Uğraşma';
  geri_donus_notu: string | null;
  // Müşteri açıkça "numaramı nereden buldunuz", "bir daha aramayın", "beni arama
  // listenizden çıkarın" gibi bir talep belirttiyse true — bkz. src/dncList.ts,
  // bu true olduğunda numara global ret listesine eklenir (TÜM danışmanlar için).
  beni_aramayin_talebi: boolean;
}

export interface CallRecord {
  callId: string;
  vapiCallId: string;
  customerName: string;
  customerPhone: string;
  customerInfo: CustomerInfo;
  startTime: string;
  endTime?: string;
  duration?: number;
  transcript: VapiTranscriptEntry[];
  // Sadece liste (GET /api/calls) yanıtında: transkript metni listede taşınmaz,
  // yerine mesaj sayısı gelir (bkz. calls.ts getAllCalls).
  transcriptCount?: number;
  costs: CallCosts;
  summary?: CallSummary;
  recordingUrl?: string;
  status: 'in-progress' | 'completed' | 'no-answer' | 'busy' | 'failed';
  notes?: string;
  followUp: boolean;
  createdAt: string;
  scenarioId?: string;
  scenarioName?: string;
  campaignId?: string;
  leadSource?: string; // hangi ilan/reklam/liste — raporlamada kaynak bazlı dönüşüm için
  isPractice?: boolean; // Roleplay Pratik görüşmesi mi — bkz. src/personas.ts
  personaId?: string;   // pratikse hangi persona ile (örn. 'fsbo-orta')
  openingVariantId?: string; // bu aramada hangi açılış varyantı kullanıldı — bkz. src/opening.ts
}

export interface Appointment {
  id: string;
  customerName: string;
  customerPhone: string;
  date: string;
  time: string;
  address: string;
  notes: string;
  createdAt: string;
  // Sistem bunu otomatik bilemez (CRM/tapu entegrasyonu yok) — danışman elle işaretler.
  outcome?: 'pending' | 'won' | 'lost';
  outcomeNote?: string;
}

// Senaryo bazında ElevenLabs TTS modeli. Boş = danışmanın Vapi asistanındaki
// varsayılan ses modeli (bugün eleven_v3) kullanılır. 'eleven_v4_turbo' seçilince
// SADECE bu senaryoyla yapılan aramalar v4 Turbo ile seslendirilir — danışmanın
// asistanına dokunulmaz (bkz. vapi.ts createVapiCall, assistantOverrides.voice).
export type ScenarioVoiceModel = 'eleven_v3' | 'eleven_v4_turbo';
export const SCENARIO_VOICE_MODELS: readonly ScenarioVoiceModel[] = ['eleven_v3', 'eleven_v4_turbo'];

// Açılış varyantı (A/B) — senaryonun [Task & Goals] adım 1'indeki açılış metninin
// yerine geçen, arama anında rastgele seçilen kısa açılış cümlesi. Aramaların %56'sı
// ilk cümleden sonra kapanıyor; açılışı prompt'u elden geçirmeden yarıştırmak için
// (bkz. src/opening.ts). text {{customerName}}/{{agentName}} değişkenlerini kullanabilir.
export interface OpeningVariant {
  id: string;
  label: string;             // ekranda görünen kısa ad ("A", "Kısa soru" …)
  text: string;              // asistanın kelimesi kelimesine söyleyeceği açılış cümlesi
  waitForGreeting: boolean;  // true: müşteri "Alo" deyince konuş (Vapi assistant-waits-for-user)
  enabled: boolean;          // false: kayıtlı kalır ama seçime girmez (istatistiği görünür)
}
export const MAX_OPENING_VARIANTS = 4;

export interface Scenario {
  id: string;
  name: string;
  systemPrompt: string;
  voiceModel?: ScenarioVoiceModel;
  openingVariants?: OpeningVariant[];
  // İsim kullanımı — ikisi de varsayılan KAPALI (undefined = false). Kapalıyken arama
  // anında prompt/açılıştaki {{customerName}} / {{agentName}} temizlenir ve modele
  // "isim söyleme" kuralı eklenir (bkz. src/opening.ts applyNameRules).
  useCustomerName?: boolean;
  useAgentName?: boolean;
  // true: asistan konuşmadan önce müşterinin "Alo" demesini bekler (Vapi
  // assistant-waits-for-user). Açılış varyantının kendi ayarı varsa o öncelikli.
  waitForGreeting?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface VapiCallRequest {
  customer: CustomerInfo;
  scenarioId?: string;
}

export interface VapiCostItem {
  type: 'vapi' | 'model' | 'voice' | 'transcriber' | 'transport' | string;
  cost: number;
  minutes?: number;
  characters?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface VapiWebhookPayload {
  message: {
    type: string;
    endedReason?: string;          // end-of-call-report ve call-ended'da mesaj düzeyinde gelir
    call?: {
      id: string;
      status?: string;
      endedReason?: string;        // bazı Vapi sürümlerinde call içinde de olabilir
      startedAt?: string;
      endedAt?: string;
      duration?: number;
    };
    role?: 'assistant' | 'user';
    transcript?: string;
    transcriptType?: 'partial' | 'final';
    cost?: number;
    costs?: VapiCostItem[];
    recordingUrl?: string;
    artifact?: {
      transcript?: string;
      messages?: Array<{ role: string; message: string; time: number }>;
      recordingUrl?: string;
    };
  };
}

export interface StatsData {
  totalCalls: number;
  completedCalls: number;
  answerRate: number;
  avgDuration: number;
  totalCost: number;
  randevuCount: number;
  randevuRate: number;
  ilgiDistribution: Array<{ seviye: string; count: number }>;
  retNedeniDistribution: Array<{ neden: string; count: number }>;
  actionDistribution: Array<{ action: string; count: number }>;
  dailyCalls: Array<{ date: string; count: number }>;
  costTrend: Array<{ date: string; cost: number }>;
  hourlyDistribution: Array<{ hour: number; count: number }>;
  statusBreakdown: Array<{ status: string; count: number }>;
  scenarioPerformance: Array<{ name: string; calls: number; randevu: number; randevuRate: number; cost: number }>;
  sourcePerformance: Array<{ source: string; calls: number; randevu: number; randevuRate: number; cost: number }>;
  randevuTrend: Array<{ date: string; rate: number; count: number }>;
}

export interface CallFilters {
  dateFrom?: string;
  dateTo?: string;
  randevu?: string;
  ilgi?: string;
  aksiyon?: string;
  status?: string;
  scenarioId?: string;
  limit?: number; // liste üst sınırı (varsayılan 500, en çok 2000 — bkz. calls.ts getAllCalls)
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ── Adaylar (Leads) ──────────────────────────────────────────────────────────

// CRM Faz 2 (2026-11): tek, kısa emlak hunisi. Eski 7 aşama (QUALIFIED/VIEWING/OFFER)
// bu altıya göç etti — bkz. normalizeLeadStage ve db.ts'teki tek seferlik UPDATE.
export const LEAD_STAGES = ['NEW', 'CONTACTED', 'MEETING', 'AGREEMENT', 'WON', 'LOST'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  NEW: 'Yeni',
  CONTACTED: 'Temas kuruldu',
  MEETING: 'Randevu',
  AGREEMENT: 'Yetki / Anlaşma',
  WON: 'Kapandı',
  LOST: 'Kayıp',
};

// Eski aşama kodlarını yeni hunideki karşılığına çevirir; bilinmeyen değer NEW olur.
// Hem DB'den okurken (eski kayıt) hem API'den gelirken (eski istemci / eski akıllı
// plan kuralı) kullanılır — aşama dışarıdan asla ham haliyle içeri girmez.
const LEGACY_STAGE_MAP: Record<string, LeadStage> = {
  QUALIFIED: 'MEETING', VIEWING: 'MEETING', OFFER: 'AGREEMENT',
};
export function normalizeLeadStage(raw: string | null | undefined): LeadStage {
  const s = String(raw || '').toUpperCase();
  if ((LEAD_STAGES as readonly string[]).includes(s)) return s as LeadStage;
  return LEGACY_STAGE_MAP[s] ?? 'NEW';
}
export function isKnownLeadStage(raw: string | null | undefined): boolean {
  const s = String(raw || '').toUpperCase();
  return (LEAD_STAGES as readonly string[]).includes(s) || s in LEGACY_STAGE_MAP;
}

// Fırsat tipi — her kişi aynı zamanda bir fırsattır; tip, kartta ve filtrede görünür.
export const DEAL_TYPES = ['SELLER', 'BUYER', 'RENTAL'] as const;
export type DealType = (typeof DEAL_TYPES)[number];
export const DEAL_TYPE_LABELS: Record<DealType, string> = { SELLER: 'Satıcı', BUYER: 'Alıcı', RENTAL: 'Kiralama' };

// Yetki durumu (satıcı fırsatlarında anlamlı).
export const AUTHORITY_TYPES = ['EXCLUSIVE', 'OPEN', 'NONE'] as const;
export type AuthorityType = (typeof AUTHORITY_TYPES)[number];
export const AUTHORITY_LABELS: Record<AuthorityType, string> = { EXCLUSIVE: 'Tek yetki', OPEN: 'Açık yetki', NONE: 'Yetki yok' };

// Kayıp nedeni — LOST'a geçişte ZORUNLU (huni raporu bunun üstüne kurulur).
export const LOST_REASONS = ['PRICE', 'OTHER_AGENT', 'GAVE_UP', 'UNREACHABLE', 'NOT_INTERESTED', 'OTHER'] as const;
export type LostReason = (typeof LOST_REASONS)[number];
export const LOST_REASON_LABELS: Record<LostReason, string> = {
  PRICE: 'Fiyat uyuşmadı',
  OTHER_AGENT: 'Başka danışmanla çalıştı',
  GAVE_UP: 'Satış / alımdan vazgeçti',
  UNREACHABLE: 'Ulaşılamadı',
  NOT_INTERESTED: 'İlgilenmiyor',
  OTHER: 'Diğer',
};

// META_LEAD_AD ve CALL_CAMPAIGN otomatik (sırasıyla Meta senkron ve arama sonucu
// tarafından) oluşturulur — danışman elle seçemez, sadece görüntüler.
export const LEAD_SOURCES = ['MANUAL', 'META_LEAD_AD', 'CSV_IMPORT', 'CALL_CAMPAIGN', 'REFERRAL', 'OTHER'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  MANUAL: 'Manuel',
  META_LEAD_AD: 'Meta Lead Ad',
  CSV_IMPORT: 'CSV İçe Aktarma',
  CALL_CAMPAIGN: 'Arama Sonucu',
  REFERRAL: 'Referans',
  OTHER: 'Diğer',
};

export interface LeadAdData {
  formId: string;
  formName: string;
  adId: string | null;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
}

export interface Lead {
  id: string;
  stage: LeadStage;
  source: LeadSource;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  region: string | null;
  reference: string | null;
  metaLeadId: string | null;
  tags: string[];
  adData: LeadAdData | null;
  linkedCallId: string | null; // arama sonucundan oluşturulduysa/güncellendiyse — bkz. onCallSummaryReady
  whatsappIgnored?: boolean; // true ise bu numaradan gelen WhatsApp yazışmaları AI analizi
                             // tetiklemez, stage hep NEW kalır — danışmanın "bu şahsi bir
                             // kişi, müşteri değil" diye elle işaretlemesi için (bkz. whatsappCampaigns.ts)
  // Toplu içe aktarmadan (CSV/Excel) geldiyse: hangi dosya/kaynak etiketi ve
  // hangi yükleme oturumundan geldiği — "bu içe aktarmayı geri al" gibi ileri
  // özellikler ve raporlama için (bkz. leads.ts importSource kullanımı).
  importSource: string | null;
  importBatchId: string | null;
  // ── Fırsat alanları (CRM Faz 2) — hepsi JSONB data içinde, hepsi boş olabilir ──
  dealType?: DealType | null;
  propertyType?: string | null;      // "3+1 daire", "arsa", "dükkan" — serbest metin; arama özeti mulk_tipi'nden de dolar
  propertyLocation?: string | null;  // mahalle / site / ilçe
  propertyM2?: number | null;
  priceExpectation?: number | null;  // TL
  authority?: AuthorityType | null;
  lostReason?: LostReason | null;    // sadece stage === 'LOST' iken dolu
  lostNote?: string | null;
  legacyStage?: string | null;       // 7 aşamalı dönemden göç eden kayıtlarda eski kod
  createdAt: string;
  updatedAt: string;
}

export const LEAD_ACTIVITY_TYPES = [
  'STAGE_CHANGE', 'NOTE', 'CALL_COMPLETED', 'ASSIGNED',
  'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'WHATSAPP_ANALYZED',
] as const;
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];

export interface LeadActivity {
  id: string;
  leadId: string;
  type: LeadActivityType;
  data: Record<string, unknown>;
  createdAt: string;
}

// ── WhatsApp (Twilio) ────────────────────────────────────────────────────────

export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export interface WhatsappTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  body: string;
  variables: string[];
  twilioContentSid: string | null;
  rejectionReason: string | null;
  status: TemplateStatus;
  createdAt: string;
  updatedAt: string;
}

export const MESSAGE_DIRECTIONS = ['IN', 'OUT'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_CHANNELS = ['TWILIO', 'PERSONAL'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface WhatsappMessage {
  id: string;
  leadId: string;
  twilioSid: string | null;
  direction: MessageDirection;
  status: string;
  body: string;
  templateId: string | null;
  campaignId: string | null;
  errorMessage: string | null;
  channel: MessageChannel;
  mediaUrl: string | null;
  createdAt: string;
}

export const CAMPAIGN_STATUSES = ['DRAFT', 'RUNNING', 'COMPLETED'] as const;
export type WhatsappCampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface WhatsappCampaignFilter {
  stages?: string[];
  sources?: string[];
}

export interface WhatsappCampaign {
  id: string;
  name: string;
  templateId: string;
  status: WhatsappCampaignStatus;
  filter: WhatsappCampaignFilter;
  variableMap: Record<string, string>;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
}
