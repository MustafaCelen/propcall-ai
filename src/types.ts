// PropCall AI - TypeScript tip tanımları

export interface CustomerInfo {
  name: string;
  phone: string;
  region: string;
  notes: string;
}

export interface CallCosts {
  vapi: number;
  twilio: number;
  llm: number;
  tts: number;
  stt: number;
  total: number;
}

export interface VapiTranscriptEntry {
  role: 'assistant' | 'user';
  text: string;
  timestamp: string;
}

export interface CallSummary {
  sicaklik_skoru: number;
  niyet: 'alım' | 'satım' | 'kiralama' | 'yatırım' | 'yok' | 'belirsiz';
  mulk_tipi: 'konut' | 'arsa' | 'işyeri' | 'belirsiz';
  bolge: string | null;
  butce: string | null;
  zaman_cercevesi: 'acil' | '3ay' | '6ay' | 'belirsiz' | 'yok';
  cevredeki_potansiyel: boolean;
  randevu_alindi: boolean;
  ozet: string;
  tavsiye_edilen_aksiyon: 'Ara' | 'Bekleme listesine al' | 'Çevre takibi' | 'Uğraşma';
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
    call?: {
      id: string;
      status?: string;
      endedReason?: string;
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
  avgDuration: number;
  avgHeatScore: number;
  totalCost: number;
  conversionRate: number;
  randevuCount: number;
  dailyCalls: Array<{ date: string; count: number }>;
  heatDistribution: Array<{ range: string; count: number }>;
  intentDistribution: Array<{ niyet: string; count: number }>;
  costTrend: Array<{ date: string; cost: number }>;
}

export interface CallFilters {
  dateFrom?: string;
  dateTo?: string;
  minScore?: number;
  maxScore?: number;
  niyet?: string;
  aksiyon?: string;
  status?: string;
  randevu?: string;
  scenarioId?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
