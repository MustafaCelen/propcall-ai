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
}

export interface Scenario {
  id: string;
  name: string;
  systemPrompt: string;
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
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
