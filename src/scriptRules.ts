// PropCall AI — Şirket geneli AI script (prompt) kısıtlamaları.
// Danışman bazlı değil, admin tarafından tanımlanır — tüm AI prompt üretimini etkiler
// (bkz. src/promptgen.ts). Tek satır, id sabit 'global'.

import pool from './db';

export interface CompanyScriptRules {
  bannedPhrases: string[];
  requiredDisclosure: string | null;
  forbidPriceCommitment: boolean;
}

const DEFAULT_RULES: CompanyScriptRules = {
  bannedPhrases: [],
  requiredDisclosure: null,
  forbidPriceCommitment: true,
};

export async function getScriptRules(): Promise<CompanyScriptRules> {
  const { rows } = await pool.query(
    `SELECT banned_phrases, required_disclosure, forbid_price_commitment FROM company_script_rules WHERE id = 'global'`,
  );
  if (!rows[0]) return DEFAULT_RULES;
  return {
    bannedPhrases: rows[0].banned_phrases || [],
    requiredDisclosure: rows[0].required_disclosure || null,
    forbidPriceCommitment: rows[0].forbid_price_commitment ?? true,
  };
}

export async function setScriptRules(rules: CompanyScriptRules): Promise<void> {
  await pool.query(
    `INSERT INTO company_script_rules (id, banned_phrases, required_disclosure, forbid_price_commitment, updated_at)
     VALUES ('global', $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       banned_phrases = $1, required_disclosure = $2, forbid_price_commitment = $3, updated_at = NOW()`,
    [rules.bannedPhrases, rules.requiredDisclosure, rules.forbidPriceCommitment],
  );
}

export interface ScriptLintResult {
  text: string;             // required_disclosure eksikse otomatik eklenmiş hali
  violations: string[];     // metinde bulunan yasaklı ifadeler (LLM'e güvenilmeden deterministik tarama)
  disclosureAdded: boolean;
}

// Üretilen prompt metnini deterministik olarak denetler — LLM kuralı unutmuş/görmezden
// gelmiş olsa bile burası son söz sahibi. Yasaklı ifadeler kaldırılmaz (prompt yapısını
// bozabilir), sadece raporlanır — required_disclosure ise otomatik eklenir (AI'a bırakılmaz).
export function lintGeneratedPrompt(text: string, rules: CompanyScriptRules): ScriptLintResult {
  const violations: string[] = [];
  for (const phrase of rules.bannedPhrases) {
    if (!phrase.trim()) continue;
    if (text.toLowerCase().includes(phrase.trim().toLowerCase())) violations.push(phrase.trim());
  }

  let outText = text;
  let disclosureAdded = false;
  if (rules.requiredDisclosure?.trim()) {
    const disclosure = rules.requiredDisclosure.trim();
    if (!text.toLowerCase().includes(disclosure.toLowerCase())) {
      outText = text.trimEnd() + '\n\n[Zorunlu Açıklama]\n' + disclosure;
      disclosureAdded = true;
    }
  }

  return { text: outText, violations, disclosureAdded };
}

// promptgen.ts'in sistem promptuna eklenecek metin — Claude'a kuralları ÖNCEDEN bildirir
// (lintGeneratedPrompt son denetim/otomatik ekleme katmanı, bu ise ilk savunma hattı).
export function rulesToSystemPromptAddendum(rules: CompanyScriptRules): string {
  const lines: string[] = [];
  if (rules.forbidPriceCommitment) {
    lines.push('- Fiyat, komisyon, indirim veya herhangi bir mali taahhüt ASLA verme.');
  }
  if (rules.bannedPhrases.length) {
    lines.push(`- Şu ifadeleri veya benzerlerini KESİNLİKLE kullanma: ${rules.bannedPhrases.join(', ')}`);
  }
  if (rules.requiredDisclosure?.trim()) {
    lines.push(`- Promptun bir yerinde (Identity veya Error Handling bölümünde) şu açıklamayı MUTLAKA içer: "${rules.requiredDisclosure.trim()}"`);
  }
  if (!lines.length) return '';
  return '\n\nEK ŞİRKET KURALLARI (zorunlu, önceki kurallarla çelişirse bunlar önceliklidir):\n' + lines.join('\n');
}
