// ElevenLabs abonelik / karakter kotası bilgisi

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

export async function getElevenLabsCredit(): Promise<ElevenLabsCreditInfo> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, error: 'ELEVENLABS_API_KEY yok' };
  try {
    const resp = await fetch(`${ELEVENLABS_BASE}/v1/user/subscription`, {
      headers: { 'xi-api-key': key },
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
