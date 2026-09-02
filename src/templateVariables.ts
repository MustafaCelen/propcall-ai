// PropCall AI — senaryo/prompt metinlerinde {{xxx}} olarak kullanılabilecek TEK
// değişken listesi (bkz. vapi.ts createVapiCall → assistantOverrides.variableValues).
// Burada olmayan bir {{değişken}} Vapi tarafından doldurulmaz — literal metin olarak,
// OLDUĞU GİBİ müşteriye okunur (bkz. "AgentName/TeamName" olayı). Yeni bir değişken
// eklenirse HEM burası HEM vapi.ts'teki variableValues objesi güncellenmeli.
export const SUPPORTED_TEMPLATE_VARIABLES = [
  'customerName',
  'customerRegion',
  'customerNotes',
  'customerReference',
  'agentName',
  'consultantName',
  'companyName',
] as const;

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// Bir metinde geçen {{xxx}} token'larından desteklenmeyenleri (muhtemelen yazım
// hatası ya da var olmayan bir değişken) bulur — sırayla, tekrarsız.
export function findUnsupportedVariables(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((m = VARIABLE_PATTERN.exec(text))) {
    const name = m[1];
    if (!(SUPPORTED_TEMPLATE_VARIABLES as readonly string[]).includes(name) && !seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}
