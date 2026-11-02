// PropCall AI — Roleplay Pratik (bkz. src/personas.ts). Danışman tarayıcıdan
// mikrofonla, telefon çevirmeden, AI'ın canlandırdığı bir müşteri persona
// (v1: FSBO) ile canlı pratik yapar. Vapi Web SDK'nın script-tag sürümünü
// (public/settings.html'deki "Sesli Test" ile aynı CDN paketi) kullanır, ama
// varsayılan yuvarlak butonu DEĞİL — kendi "Başlat"/"Bitir" arayüzümüzü, ki
// vapi.start()'ın dönüş değerinden GERÇEK call id'yi senkron alabilelim
// (window.vapiSDK.run()'ın kendi otomatik butonu bunu bize vermez, fire-and-forget
// çağırır — bkz. VapiAI/client-sdk-html-script-tag src/listeners.js).

const roleplayState = { personas: [], ratePerMinute: 10, activeVapi: null, activePersonaId: null, isStarting: false, selectedFamily: null };

// Aile kartları için ikon/altyazı — personas.ts'teki family string'leriyle eşleşir.
const RP_FAMILY_META = {
  FSBO:              { icon: '🏠', title: 'FSBO', sub: 'Evini emlakçısız satan mal sahibi' },
  FRBO:              { icon: '🔑', title: 'FRBO', sub: 'Evini emlakçısız kiralayan mal sahibi' },
  'Expired Listing':  { icon: '⏳', title: 'Süresi Dolan İlan', sub: 'Başka bir emlakçıyla süresi dolmuş sahibi' },
  'Internet Lead':    { icon: '💻', title: 'İnternet Lead', sub: 'Portaldan ilgi gösteren potansiyel müşteri' },
  'Price Reduction':  { icon: '📉', title: 'Fiyat İndirimi', sub: 'Fiyat düşürmeye ikna edilmesi gereken satıcı' },
  'Sphere/Referral':  { icon: '🤝', title: 'Çevre/Referans', sub: 'Tanıdık/referans üzerinden gelen müşteri' },
  'Open House':       { icon: '🚪', title: 'Açık Ev', sub: 'Açık evi ziyaret eden potansiyel müşteri' },
};

function loadRoleplaySdk() {
  return new Promise((resolve, reject) => {
    if (window.vapiSDK) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/gh/VapiAI/html-script-tag@latest/dist/assets/index.js';
    script.defer = true;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Vapi SDK yüklenemedi (ağ/CDN erişimi kontrol edin)'));
    document.body.appendChild(script);
  });
}

const RP_DIFFICULTY_LABEL = { kolay: '🟢 Kolay', orta: '🟡 Orta', zor: '🔴 Zor' };

async function loadRoleplayTab() {
  const wrap = $('roleplayCards');
  wrap.innerHTML = '<div class="drawer-loading">⏳ Yükleniyor...</div>';
  try {
    const r = await fetch('/api/roleplay/personas');
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Personalar yüklenemedi');
    roleplayState.personas = j.data.personas;
    roleplayState.ratePerMinute = j.data.ratePerMinute;
    roleplayState.selectedFamily = null;
    renderFamilyCards();
  } catch (err) {
    wrap.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

// ─── Aşama 1: senaryo ailesi seçimi ─────────────────────────────────────────
function renderFamilyCards() {
  const wrap = $('roleplayCards');
  $('roleplayRateNote').textContent =
    `Bir senaryo seçin, ardından zorluk seviyesini belirleyin. Görüşmeler gerçek bir arama gibi dakika başı ${roleplayState.ratePerMinute} TL bakiyenizden düşülür.`;

  const families = [...new Set(roleplayState.personas.map(p => p.family))];

  wrap.className = 'rp-cards rp-cards-family';
  wrap.innerHTML = families.map(f => {
    const meta = RP_FAMILY_META[f] || { icon: '🎯', title: f, sub: '' };
    const count = roleplayState.personas.filter(p => p.family === f).length;
    return `
      <div class="rp-card rp-family-card" data-family="${esc(f)}">
        <div class="rp-family-icon">${meta.icon}</div>
        <div class="rp-card-title">${esc(meta.title)}</div>
        <div class="rp-card-desc">${esc(meta.sub)}</div>
        <div class="rp-family-count">${count} zorluk seviyesi</div>
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('.rp-family-card').forEach(card => {
    card.addEventListener('click', () => {
      roleplayState.selectedFamily = card.dataset.family;
      renderDifficultyCards();
    });
  });
}

// ─── Aşama 2: seçilen ailenin zorluk seviyesi ───────────────────────────────
function renderDifficultyCards() {
  const wrap = $('roleplayCards');
  const family = roleplayState.selectedFamily;
  const meta = RP_FAMILY_META[family] || { icon: '🎯', title: family, sub: '' };
  const personas = roleplayState.personas.filter(p => p.family === family);

  $('roleplayRateNote').textContent =
    `Bu görüşmeler gerçek bir arama gibi dakika başı ${roleplayState.ratePerMinute} TL bakiyenizden düşülür.`;

  wrap.className = 'rp-cards';
  wrap.innerHTML = `
    <button class="rp-back-btn" id="rpBackToFamilies">← Senaryolara Dön</button>
    <div class="rp-difficulty-heading">${meta.icon} ${esc(meta.title)}</div>
  ` + personas.map(p => `
    <div class="rp-card" data-persona-id="${p.id}">
      <div class="rp-card-badge">${RP_DIFFICULTY_LABEL[p.difficulty] || p.difficulty}</div>
      <div class="rp-card-title">${esc(p.label)}</div>
      <div class="rp-card-desc">${esc(p.description)}</div>
      <a href="#" class="rp-card-detail-link" data-persona-id="${p.id}">📋 Detayları Gör</a>
      <button class="btn-start rp-card-btn" data-persona-id="${p.id}">🎙️ Pratiğe Başla</button>
      <div class="rp-card-status" id="rpStatus-${p.id}"></div>
    </div>
  `).join('');

  $('rpBackToFamilies').addEventListener('click', () => {
    roleplayState.selectedFamily = null;
    renderFamilyCards();
  });
  wrap.querySelectorAll('.rp-card-btn').forEach(btn => {
    btn.addEventListener('click', () => onRoleplayButtonClick(btn.dataset.personaId));
  });
  wrap.querySelectorAll('.rp-card-detail-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      openBriefingModal(link.dataset.personaId);
    });
  });
}

// ─── Brifing modalı — görüşme öncesi hazırlık bilgisi ──────────────────────
function openBriefingModal(personaId) {
  const persona = roleplayState.personas.find(p => p.id === personaId);
  if (!persona?.briefing) return;
  const b = persona.briefing;

  const overlay = document.createElement('div');
  overlay.className = 'rp-briefing-overlay';
  overlay.innerHTML = `
    <div class="rp-briefing-modal">
      <div class="rp-briefing-header">
        <div>
          <div class="rp-briefing-title">${esc(persona.label)}</div>
          <div class="rp-briefing-sub">${esc(b.kisi)}</div>
        </div>
        <button class="rp-briefing-close">✕</button>
      </div>
      <div class="rp-briefing-body">
        <div class="rp-briefing-row">
          <div class="rp-briefing-label">🏠 Mülk</div>
          <div class="rp-briefing-value">${b.mulk.map(x => esc(x)).join('<br>')}</div>
        </div>
        <div class="rp-briefing-row">
          <div class="rp-briefing-label">💰 Fiyat</div>
          <div class="rp-briefing-value">${esc(b.fiyat)}</div>
        </div>
        <div class="rp-briefing-row">
          <div class="rp-briefing-label">📖 Durum</div>
          <div class="rp-briefing-value">${esc(b.durum)}</div>
        </div>
        <div class="rp-briefing-row">
          <div class="rp-briefing-label">⚠️ Beklenen İtirazlar</div>
          <div class="rp-briefing-value">${b.itirazlar.map(x => '• ' + esc(x)).join('<br>')}</div>
        </div>
        <div class="rp-briefing-row rp-briefing-hedef">
          <div class="rp-briefing-label">🎯 Hedef</div>
          <div class="rp-briefing-value">${esc(b.hedef)}</div>
        </div>
      </div>
      <div class="rp-briefing-actions">
        <button class="btn-start rp-briefing-start">🎙️ Pratiğe Başla</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.rp-briefing-close').addEventListener('click', close);
  overlay.querySelector('.rp-briefing-start').addEventListener('click', () => {
    close();
    onRoleplayButtonClick(personaId);
  });
}

function onRoleplayButtonClick(personaId) {
  if (roleplayState.activeVapi && roleplayState.activePersonaId === personaId) {
    endRoleplay(personaId);
  } else if (roleplayState.activeVapi) {
    toast('✗ Önce mevcut pratiği bitirin', 'error');
  } else {
    startRoleplay(personaId);
  }
}

async function startRoleplay(personaId) {
  // Çift-tıklama/çift-başlatma koruması — window.vapiSDK.run() her çağrıldığında
  // YENİ bir Vapi instance'ı (ve alttaki Daily.co/Krisp SDK'sını) yaratır; önceki
  // instance temizlenmeden ikinci bir run() tetiklenirse iki ayrı call/mikrofon
  // akışı üst üste biner — "görüşme donuyor/ölüyor" ve "KrispSDK duplicated"
  // konsol uyarısının kök nedeni buydu. isStarting bayrağı, "Hazırlanıyor..."
  // aşamasında (activeVapi henüz set edilmeden önce) gelecek ikinci bir tıklamayı
  // da engeller — sadece onRoleplayButtonClick'teki activeVapi kontrolü yeterli değildi.
  if (roleplayState.isStarting) return;
  roleplayState.isStarting = true;

  const persona = roleplayState.personas.find(p => p.id === personaId);
  const btn = document.querySelector(`.rp-card-btn[data-persona-id="${personaId}"]`);
  const status = $('rpStatus-' + personaId);
  if (!confirm(`"${persona.label}" ile pratiğe başlamak üzeresiniz — dakika başı ${roleplayState.ratePerMinute} TL bakiyenizden düşülecek. Devam edilsin mi?`)) {
    roleplayState.isStarting = false;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Hazırlanıyor...';
  status.textContent = '';
  status.className = 'rp-card-status';
  try {
    const [overridesRes, settingsRes] = await Promise.all([
      fetch('/api/roleplay/assistant-overrides/' + encodeURIComponent(personaId)),
      fetch('/api/settings'),
    ]);
    const overridesJson = await overridesRes.json();
    if (!overridesJson.success) throw new Error(overridesJson.error || 'Persona hazırlanamadı');
    const settingsJson = await settingsRes.json();
    if (!settingsJson.success) throw new Error(settingsJson.error || 'Ayarlar okunamadı');
    const publicKey = settingsJson.data.vapiPublicKey?.value;
    if (!publicKey) throw new Error('Önce Vapi Public Key\'inizi kaydedin (Ayarlarım → Hesap Bağlantıları)');

    const { assistantId, assistantOverrides } = overridesJson.data;

    await loadRoleplaySdk();
    // NOT: window.vapiSDK.run() kendi görünür/tıklanabilir yuvarlak butonunu (id
    // "vapi-support-btn") DOM'a ekler. Daha önce bu butonu display:none/pointerEvents:none/
    // disabled ile DOM manipülasyonuyla gizlemeyi denedik — bu, SDK'nın/Daily.co'nun iç
    // mekanizmasını bozup görüşmenin hiç başlamamasına yol açtı (kullanıcı doğrulaması:
    // "ilk versiyon çalışıyordu, buton-gizleme değişikliğinden sonra bozuldu"). O yüzden
    // artık DOM'a HİÇ dokunmuyoruz — buton görünür kalıyor, kullanıcı ona TIKLAMAMALI
    // (kendi kart butonumuzu kullanmalı), CSS ile sadece küçük/dikkat çekmeyecek şekilde
    // stillendirilebilir ama disabled/pointerEvents:none YAPILMAZ.
    const vapi = window.vapiSDK.run({
      apiKey: publicKey,
      assistant: assistantId,
      assistantOverrides,
      config: { position: 'bottom-right', size: 'medium', theme: 'dark' },
    });
    if (!vapi) throw new Error('Vapi SDK başlatılamadı');

    // Her callback try/catch ile sarmalı — Vapi Web SDK bu event'leri KENDİ
    // internal event loop'unda tetikliyor, içeride fırlayan bir exception bizim
    // dışımızdaki try/catch'e YAKALANMAZ (asenkron, ayrı bir call stack) ve
    // konsola sessizce "Uncaught" olarak düşer — kullanıcıya UI'ın "donmuş/ölmüş"
    // görünmesi olarak yansır, halbuki sayfa çalışmaya devam ediyordur.
    vapi.on('call-end', () => {
      try {
        status.textContent = 'Görüşme bitti.';
        status.className = 'rp-card-status ok';
        resetRoleplayButton(personaId);
        hideTranscriptPanel();
      } catch (e) { console.error('[Roleplay] call-end handler hatası:', e); }
    });
    vapi.on('error', (err) => {
      try {
        console.error('[Roleplay] Vapi hatası:', err);
        toast('✗ Görüşme hatası: ' + (err?.message || 'bilinmeyen hata'), 'error');
        resetRoleplayButton(personaId);
        hideTranscriptPanel();
      } catch (e) { console.error('[Roleplay] error handler hatası:', e); }
    });
    vapi.on('message', (msg) => {
      try {
        if (msg?.type === 'transcript') handleTranscriptMessage(msg);
      } catch (e) { console.error('[Roleplay] message handler hatası:', e); }
    });

    // Paneli start'tan ÖNCE aç — bağlantı birkaç saniye sürebiliyor, kullanıcı bu
    // sırada hiçbir geri bildirim görmüyordu. Hata olursa catch bloğu kapatıyor.
    showTranscriptPanel(persona.label, 'Bağlanıyor...');

    const call = await vapi.start(assistantId, assistantOverrides);
    if (!call?.id) throw new Error('Görüşme başlatılamadı (call id alınamadı)');

    roleplayState.activeVapi = vapi;
    roleplayState.activePersonaId = personaId;
    btn.disabled = false;
    btn.textContent = '🔴 Görüşmeyi Bitir';
    status.textContent = '🎙️ Görüşme aktif — önce siz "merhaba" deyip kendinizi tanıtın.';
    status.className = 'rp-card-status ok';
    setTranscriptHint('Önce siz konuşun — "Merhaba, ben ... " diyerek kendinizi tanıtın.');

    fetch('/api/roleplay/register-call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vapiCallId: call.id, personaId }),
    }).catch(err => console.error('[Roleplay] register-call gönderilemedi:', err));
  } catch (err) {
    toast('✗ ' + err.message, 'error');
    resetRoleplayButton(personaId);
    hideTranscriptPanel();
  } finally {
    roleplayState.isStarting = false;
  }
}

function endRoleplay(personaId) {
  const vapi = roleplayState.activeVapi;
  if (vapi) vapi.stop();
  const status = $('rpStatus-' + personaId);
  if (status) { status.textContent = 'Görüşme sonlandırılıyor...'; }
  resetRoleplayButton(personaId);
  hideTranscriptPanel();
}

function resetRoleplayButton(personaId) {
  roleplayState.activeVapi = null;
  roleplayState.activePersonaId = null;
  roleplayState.isStarting = false;
  const btn = document.querySelector(`.rp-card-btn[data-persona-id="${personaId}"]`);
  if (btn) { btn.disabled = false; btn.textContent = '🎙️ Pratiğe Başla'; }
}

// ─── Canlı transkript / altyazı paneli ─────────────────────────────────────
// Vapi Web SDK'nın 'message' event'i sunucudaki webhook'la AYNI şekli taşır
// ({type:'transcript', role, transcriptType:'partial'|'final', transcript}) —
// bkz. src/server.ts handleWebhook 'transcript' case'i. 'partial' konuşma
// bitmeden gelen ANLIK (sürekli üzerine yazılan) metin, altyazı hissi verir;
// 'final' geldiğinde o satır kalıcı hale gelir ve yeni bir satıra geçilir.
let rpPartialLineEl = null;
let rpPartialRole = null;

function setTranscriptHint(text) {
  const body = $('roleplayTranscriptBody');
  if (!body) return;
  let hint = body.querySelector('.rp-transcript-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'rp-transcript-hint';
    body.appendChild(hint);
  }
  hint.textContent = text;
}

function showTranscriptPanel(personaLabel, hint) {
  const overlay = $('roleplayTranscriptOverlay');
  const body = $('roleplayTranscriptBody');
  $('rpTranscriptTitle').textContent = '🎙️ Canlı Görüşme — ' + personaLabel;
  body.innerHTML = '';
  rpPartialLineEl = null;
  rpPartialRole = null;
  if (hint) setTranscriptHint(hint);
  // Artık .rp-scroll içinde gömülü DEĞİL, sayfaya sabit konumlu bir popup
  // (briefing modalıyla aynı desen) — scroll/zoom'dan bağımsız her zaman görünür.
  overlay.style.display = 'flex';
}

function hideTranscriptPanel() {
  const overlay = $('roleplayTranscriptOverlay');
  if (overlay) overlay.style.display = 'none';
  rpPartialLineEl = null;
  rpPartialRole = null;
}

function handleTranscriptMessage(msg) {
  const body = $('roleplayTranscriptBody');
  if (!body || !msg.role || !msg.transcript) return;

  if (msg.transcriptType === 'partial') {
    // Aynı konuşmacının devam eden cümlesiyse mevcut "canlı" satırı güncelle,
    // konuşmacı değiştiyse (örn. asistan → kullanıcı geçişi) yeni bir satır aç.
    if (!rpPartialLineEl || rpPartialRole !== msg.role) {
      rpPartialLineEl = appendTranscriptLine(msg.role, msg.transcript, true);
      rpPartialRole = msg.role;
    } else {
      rpPartialLineEl.querySelector('.rp-transcript-bubble').textContent = msg.transcript;
    }
  } else if (msg.transcriptType === 'final') {
    if (rpPartialLineEl && rpPartialRole === msg.role) {
      // Canlı satırı kalıcı hale getir — tekrar bir satır eklemeye gerek yok.
      const bubble = rpPartialLineEl.querySelector('.rp-transcript-bubble');
      bubble.textContent = msg.transcript;
      bubble.classList.remove('partial');
    } else {
      appendTranscriptLine(msg.role, msg.transcript, false);
    }
    rpPartialLineEl = null;
    rpPartialRole = null;
  }
  body.scrollTop = body.scrollHeight;
}

function appendTranscriptLine(role, text, isPartial) {
  const body = $('roleplayTranscriptBody');
  // İlk gerçek replik geldiğinde "Bağlanıyor/önce siz konuşun" ipucunu kaldır.
  const hint = body.querySelector('.rp-transcript-hint');
  if (hint) hint.remove();
  const line = document.createElement('div');
  line.className = 'rp-transcript-line ' + (role === 'user' ? 'user' : 'assistant');
  line.innerHTML =
    '<span class="rp-transcript-speaker">' + (role === 'user' ? 'Siz' : 'Müşteri') + '</span>' +
    '<span class="rp-transcript-bubble' + (isPartial ? ' partial' : '') + '">' + esc(text) + '</span>';
  body.appendChild(line);
  return line;
}

document.addEventListener('DOMContentLoaded', () => {
  const endBtn = $('btnRoleplayEndFromPanel');
  if (endBtn) endBtn.addEventListener('click', () => {
    if (roleplayState.activePersonaId) endRoleplay(roleplayState.activePersonaId);
  });
});
