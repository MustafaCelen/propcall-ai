// ElevenLabs abonelik / karakter kotası bilgisi — her danışman kendi hesabını kullanır.

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

export interface ElevenLabsCreditInfo {
  ok: boolean;
  used?: number;          // Kullanılmış karakter
  limit?: number;         // Toplam kota
  remaining?: number;     // Kalan karakter
  tier?: string;          // Plan
  resetTs?: number;       // Yenilenme (unix ms)
  error?: string;
}

export async function getElevenLabsCredit(apiKey: string): Promise<ElevenLabsCreditInfo> {
  if (!apiKey) return { ok: false, error: 'ELEVENLABS_API_KEY yok' };
  try {
    const resp = await fetch(`${ELEVENLABS_BASE}/v1/user/subscription`, {
      headers: { 'xi-api-key': apiKey },
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as {
      tier?: string;
      character_count?: number;
      character_limit?: number;
      next_character_count_reset_unix?: number;
    };
    const used  = data.character_count ?? 0;
    const limit = data.character_limit ?? 0;
    return {
      ok: true,
      used, limit,
      remaining: Math.max(0, limit - used),
      tier: data.tier,
      resetTs: data.next_character_count_reset_unix
        ? data.next_character_count_reset_unix * 1000
        : undefined,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Vapi'nin cost webhook'u BYO ElevenLabs kullanıldığında tts kalemini raporlamıyor
// (her zaman 0) — bu yüzden asistanın gerçekten söylediği metnin karakter sayısından,
// kullanıcının kendi girdiği $/1000-karakter oranına göre tahmini hesaplıyoruz.
export function estimateTtsCost(charCount: number, ratePer1kChars: number | null | undefined): number {
  if (!ratePer1kChars || charCount <= 0) return 0;
  return Math.round((charCount / 1000) * ratePer1kChars * 1e6) / 1e6;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category?: string;
  previewUrl?: string;
}

// Hesaba tanımlı sesleri listele — Ayarlarım sayfasında dropdown için
export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY tanımlanmamış (Ayarlarım sayfasından ekleyin)');

  const resp = await fetch(`${ELEVENLABS_BASE}/v1/voices`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!resp.ok) throw new Error(`ElevenLabs ses listesi alınamadı: ${resp.status}`);
  const data = await resp.json() as {
    voices?: Array<{ voice_id: string; name: string; category?: string; preview_url?: string }>;
  };
  return (data.voices || []).map(v => ({
    voiceId: v.voice_id, name: v.name, category: v.category, previewUrl: v.preview_url,
  }));
}
