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
  randevu_alindi: boolean;
  ret_nedeni: string | null;
  ilgi_seviyesi: 'yüksek' | 'orta' | 'düşük' | 'yok';
  mulk_tipi: string | null;
  ozet: string;
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

export interface VapiCallRequest {
  customer: CustomerInfo;
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
  totalCost: number;
  appointmentCount: number;
  appointmentRate: number;
  dailyCalls: Array<{ date: string; count: number }>;
  dailyAppointments: Array<{ date: string; count: number }>;
  costTrend: Array<{ date: string; cost: number }>;
}

export interface CallFilters {
  dateFrom?: string;
  dateTo?: string;
  randevu?: string;
  ilgi?: string;
  status?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
