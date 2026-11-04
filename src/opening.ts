// PropCall AI — Açılış varyantları (A/B testi).
//
// 75 günlük canlı veri: konuşma gerçekleşen aramaların %56'sı müşterinin ilk
// tepkisinden sonra kapanıyor, asistan ana soruyu aramaların yalnızca ~%11'inde
// sorabiliyor; açılış cümlesi medyan 19 kelime. Kayıp açılışta. Bu modül, senaryo
// prompt'unu elden geçirmeden açılış cümlesini yarıştırmayı sağlar: senaryoya 2-4
// kısa açılış yazılır, her aramada biri rastgele seçilir, prompt'un başına "ilk
// cümlen AYNEN bu" bloğu eklenir ve arama kaydına varyant id'si yazılır. Sonuçlar
// varyant bazında (erken kapanma, soruya ulaşma, randevu) karşılaştırılır.

import { OpeningVariant, Scenario, CallRecord, MAX_OPENING_VARIANTS } from './types';
import { findUnsupportedVariables } from './templateVariables';

// Analizden çıkan "altın açılış" şablonu: ≤12 kelime, kısa marka + tek soru, isimsiz
// (isimler senaryoda açıkça açılmadıkça söylenmez — bkz. applyNameRules).
// Marka olarak "Platin Karma" — "Keller Williams" transkriptlerin %93'ünde bozuk
// okunuyordu, "&" ise "and" diye seslendiriliyor.
export const GOLDEN_OPENING_TEXT =
  'Merhaba, Platin Karma\'dan arıyorum. Kısa bir sorum var, satmayı düşündüğünüz bir mülkünüz var mı?';

// ─── İsim kuralları ──────────────────────────────────────────────────────────
// Senaryo bayrakları kapalıyken (varsayılan) metindeki isim değişkenleri silinir ve
// kalan noktalama toparlanır: "Merhaba {{customerName}}, Platin Karma'dan {{agentName}}."
// → "Merhaba, Platin Karma'dan." Model ayrıca açık kuralla uyarılır; küçük pürüzleri
// kendisi düzeltir. Kalan tek bir değişken bile okunmasın diye variableValues'ta da
// ilgili alan BOŞ gönderilir (bkz. nameVariableValues).
export function stripNameVariables(text: string, opts: { customer: boolean; agent: boolean }): string {
  let t = text;
  if (!opts.customer) t = t.replace(/\{\{\s*customerName\s*\}\}/g, '');
  if (!opts.agent) {
    t = t.replace(/Adın\s*\{\{\s*agentName\s*\}\}\s*,\s*/g, '');   // "Adın {{agentName}}, Keller…" → "Keller…"
    t = t.replace(/(['’]dan|['’]den)\s*\{\{\s*agentName\s*\}\}/g, '$1 arıyorum'); // "Karma'dan {{agentName}}" → "Karma'dan arıyorum"
    t = t.replace(/\{\{\s*agentName\s*\}\}/g, '');
  }
  if (t === text) return text;
  return t
    .replace(/[ \t]+,/g, ',')          // "Merhaba ," → "Merhaba,"
    .replace(/,\s*,/g, ',')            // ", ," → ","
    .replace(/[ \t]+\./g, '.')         // "dan ." → "dan."
    .replace(/[ \t]{2,}/g, ' ');
}

const NAME_RULE_HEADER = '[İsim Kuralı — ZORUNLU]';
export function applyNameRules(systemPrompt: string, scenario: Scenario): string {
  const customer = scenario.useCustomerName === true;
  const agent = scenario.useAgentName === true;
  if (customer && agent) return systemPrompt;
  const lines: string[] = [];
  if (!customer) lines.push('- Müşterinin adını veya soyadını ASLA söyleme, isimle hitap etme; "Merhaba" ile başla.');
  if (!agent) lines.push('- Kendi adını söyleme. Kim olduğun sorulursa "Platin Karma\'nın yapay zeka asistanıyım" de.');
  return `${NAME_RULE_HEADER}\n${lines.join('\n')}\n\n${stripNameVariables(systemPrompt, { customer, agent })}`;
}

// Vapi variableValues için: bayrak kapalıysa alan boş gider — prompt'ta gözden kaçan
// bir {{customerName}} bile olsa model boş metin görür, isim okumaz.
export function nameVariableValues(
  scenario: Scenario | null | undefined, customerName: string, agentName: string,
): { customerName: string; agentName: string } {
  if (!scenario) return { customerName, agentName }; // senaryosuz arama: Vapi baz promptu, eski davranış
  return {
    customerName: scenario.useCustomerName ? customerName : '',
    agentName: scenario.useAgentName ? agentName : '',
  };
}

export const OPENING_TEXT_MAX_CHARS = 300;

// İstemciden gelen ham listeyi doğrular/normalize eder. Hata metni döner (400 için),
// yoksa temiz liste. undefined → alana dokunulmaz (eski istemciler).
export function parseOpeningVariants(raw: unknown): { ok: true; variants: OpeningVariant[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'Açılış varyantları liste olmalı' };
  if (raw.length > MAX_OPENING_VARIANTS) return { ok: false, error: `En fazla ${MAX_OPENING_VARIANTS} açılış varyantı eklenebilir` };
  const variants: OpeningVariant[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i] as Record<string, unknown>;
    if (!v || typeof v !== 'object') return { ok: false, error: 'Geçersiz açılış varyantı' };
    const text = String(v.text ?? '').trim();
    if (!text) return { ok: false, error: `${i + 1}. açılış varyantının metni boş` };
    if (text.length > OPENING_TEXT_MAX_CHARS) return { ok: false, error: `${i + 1}. açılış varyantı çok uzun (en fazla ${OPENING_TEXT_MAX_CHARS} karakter)` };
    const unknown = findUnsupportedVariables(text);
    if (unknown.length) return { ok: false, error: `Açılış varyantında tanınmayan değişken: ${unknown.map(u => '{{' + u + '}}').join(', ')}` };
    // id istemciden gelir (düzenlemede korunmalı — eski aramaların istatistiği ona bağlı);
    // yoksa üretilir. Çakışan id'ler yeniden üretilir.
    let id = typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(v.id) ? v.id : '';
    if (!id || seen.has(id)) id = `ov_${Date.now().toString(36)}_${i}`;
    seen.add(id);
    const label = String(v.label ?? '').trim().slice(0, 30) || String.fromCharCode(65 + i); // A, B, C…
    variants.push({ id, label, text, waitForGreeting: v.waitForGreeting === true, enabled: v.enabled !== false });
  }
  return { ok: true, variants };
}

// Aktif varyantlar arasından eşit olasılıkla seçer. Varyant yoksa null → senaryo
// prompt'u olduğu gibi kullanılır (bugünkü davranış).
export function pickOpeningVariant(scenario: Scenario | null | undefined): OpeningVariant | null {
  const active = (scenario?.openingVariants || []).filter(v => v.enabled && v.text.trim());
  if (!active.length) return null;
  return active[Math.floor(Math.random() * active.length)];
}

// "Önce Alo bekle": varyant seçildiyse varyantın ayarı, yoksa senaryonun ayarı.
export function resolveWaitForGreeting(scenario: Scenario | null | undefined, opening: OpeningVariant | null): boolean {
  if (opening) return opening.waitForGreeting === true;
  return scenario?.waitForGreeting === true;
}

// Arama anında modele gidecek nihai prompt: açılış varyantı (varsa) + isim kuralları.
// Tek giriş noktası — kampanya ve tekil arama aynı yolu kullanır.
export function buildCallPrompt(scenario: Scenario | null | undefined, opening: OpeningVariant | null): string | undefined {
  if (!scenario?.systemPrompt) return undefined;
  const withOpening = opening ? applyOpeningVariant(scenario.systemPrompt, opening, scenario) : scenario.systemPrompt;
  return applyNameRules(withOpening, scenario);
}

// Prompt'un BAŞINA eklenir — modeller prompt'un başını ortasından daha güçlü
// ağırlıklandırır ve bu blok senaryodaki adım 1 metnini geçersiz kılmalı.
export function applyOpeningVariant(systemPrompt: string, variant: OpeningVariant, scenario?: Scenario): string {
  const timing = variant.waitForGreeting
    ? 'Müşteri "Alo", "Efendim", "Buyrun" gibi bir şey deyince konuşmaya başla; o konuşmadan önce hiçbir şey söyleme.'
    : 'Hat açılır açılmaz konuş. Müşteri aynı anda "Alo" derse açılışı yarıda kesip baştan alma, cümleyi tamamla.';
  const text = scenario
    ? stripNameVariables(variant.text.trim(), { customer: scenario.useCustomerName === true, agent: scenario.useAgentName === true })
    : variant.text.trim();
  return `[AÇILIŞ — ZORUNLU, aşağıdaki [Task & Goals] adım 1'deki açılış metninin YERİNE geçer]
İlk cümlen kelimesi kelimesine, ekleme ve çıkarma yapmadan AYNEN şu olacak:
"${text}"
${timing}
Açılışı söyledikten sonra müşterinin yanıtını bekle ve [Task & Goals] adım 2'den itibaren senaryoyu aynen izle; adım 1'i tekrar söyleme.

${systemPrompt}`;
}

// ─── Varyant bazlı sonuç ─────────────────────────────────────────────────────
// Ölçüler analiz scriptleriyle aynı tanımı kullanır (karşılaştırılabilir kalsın):
// konuşulan = hem müşteri hem asistan en az bir kez konuştu; erken kapanma =
// müşteri kapattı ve müşteri ≤1 kez konuştu; soruya ulaştı = asistan metninde
// soru kalıbı var.
const QUESTION_RE = /\?|mıdır|midir|mudur|müdür|misiniz|mısınız|musunuz|müsünüz| mı | mi | mu | mü |var mı|ister mi/;
const normTr = (s: string) => (s || '').toLocaleLowerCase('tr').replace(/[^a-zçğıöşü0-9 ?]/g, ' ').replace(/\s+/g, ' ').trim();

export interface OpeningVariantStats {
  variantId: string | null;   // null = varyantsız (senaryonun kendi açılışı)
  calls: number;              // konuşma gerçekleşen arama
  earlyHangupPct: number | null;
  reachedQuestionPct: number | null;
  appointmentPct: number | null;
  interestPct: number | null; // ilgi orta/yüksek
  medianDurationSec: number | null;
}

export function computeOpeningStats(calls: CallRecord[]): OpeningVariantStats[] {
  const groups = new Map<string | null, CallRecord[]>();
  for (const c of calls) {
    if (!Array.isArray(c.transcript)) continue;
    const talked = c.transcript.some(t => t.role === 'user') && c.transcript.some(t => t.role === 'assistant');
    if (!talked) continue;
    const key = c.openingVariantId || null;
    (groups.get(key) || groups.set(key, []).get(key)!).push(c);
  }
  const pct = (a: number, b: number) => b ? Math.round(100 * a / b) : null;
  const out: OpeningVariantStats[] = [];
  for (const [variantId, list] of groups) {
    let early = 0, reached = 0, appt = 0, interest = 0;
    const durs: number[] = [];
    for (const c of list) {
      const userTurns = c.transcript.filter(t => t.role === 'user').length;
      const endedReason = (c as unknown as { endedReason?: string }).endedReason;
      if (endedReason === 'customer-ended-call' && userTurns <= 1) early++;
      const botText = normTr(c.transcript.filter(t => t.role === 'assistant').map(t => t.text).join(' '));
      if (QUESTION_RE.test(botText)) reached++;
      if (c.summary?.randevu_alindi) appt++;
      if (c.summary && ['yüksek', 'orta'].includes(c.summary.ilgi_seviyesi)) interest++;
      if (typeof c.duration === 'number') durs.push(c.duration);
    }
    durs.sort((a, b) => a - b);
    out.push({
      variantId, calls: list.length,
      earlyHangupPct: pct(early, list.length), reachedQuestionPct: pct(reached, list.length),
      appointmentPct: pct(appt, list.length), interestPct: pct(interest, list.length),
      medianDurationSec: durs.length ? durs[Math.floor(durs.length / 2)] : null,
    });
  }
  return out.sort((a, b) => b.calls - a.calls);
}
