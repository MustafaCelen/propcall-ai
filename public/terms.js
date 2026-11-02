// PropCall AI — Kullanım Koşulları ve Sorumluluk Beyanı gate'i. Danışman, mevcut
// versiyonu (CURRENT_TERMS_VERSION, backend auth.ts ile birebir aynı sayı olmalı)
// kabul etmeden uygulamanın geri kalanına erişemez — app.js DOMContentLoaded içinde
// session kontrolünden hemen sonra bunu çağırır, kalan init'leri hiç çalıştırmaz.
const CURRENT_TERMS_VERSION = 1;

const TERMS_TEXT_HTML = `
  <p><b>Bu metin bir hukuki danışmanlık değildir</b> — PropCall AI'yi (bundan sonra
  "Sistem") kullanmadan önce dikkatle okuyun. Sorularınız için şirketinizin hukuk
  danışmanına başvurun.</p>

  <h4>1. Sistemin niteliği</h4>
  <p>Sistem, Keller Williams Platin&amp;Karma tarafından danışmanlarına sunulan bir
  <b>araçtır</b>. Kimi arayacağınıza, kime mesaj göndereceğinize ve hangi kişisel
  verileri işleyeceğinize siz karar verirsiniz. Şirket, Sistemi sağlar; Sistemi
  kullanarak yaptığınız her aramanın/mesajın hukuka uygunluğunun denetimini yapmaz
  ve yapamaz.</p>

  <h4>2. İYS ve arama/mesaj izni sorumluluğu SİZE aittir</h4>
  <p>6563 sayılı Kanun ve İYS mevzuatı uyarınca, ticari elektronik ileti
  (arama/SMS/WhatsApp) göndereceğiniz her numara için önceden alınmış geçerli bir
  <b>izniniz</b> olmalı ve o numara İYS ret listesinde olmamalıdır. Bu kontrolü
  yapmak, gerekli izinleri almak ve güncel tutmak tamamen sizin sorumluluğunuzdur.
  Sistem, yüklediğiniz aday/kişi listelerinin İYS uygunluğunu doğrulamaz.</p>

  <h4>3. KVKK — kişisel verilerin işlenmesi</h4>
  <p>Aday/müşteri bilgilerini (ad, telefon, görüşme notları, ses kaydı, WhatsApp
  yazışmaları) Sisteme girerken 6698 sayılı KVKK kapsamında <b>veri sorumlusu</b>
  sizsiniz. İlgili kişileri aydınlatma yükümlülüğünüzü yerine getirmek, açık rıza
  gerekiyorsa almak ve verileri hukuka uygun işlemek sizin sorumluluğunuzdadır.</p>

  <h4>4. Üçüncü taraf alt işlemciler</h4>
  <p>Sistem; aramaları gerçekleştirmek, sesi yazıya/metni sese çevirmek ve
  görüşmeleri özetlemek için Vapi, ElevenLabs ve Anthropic gibi üçüncü taraf
  hizmet sağlayıcılarını kullanır. Bu sağlayıcılara ses kaydı ve görüşme metni
  aktarılır. Bu aktarımı ilgili kişilere açıklamak (gerekiyorsa aydınlatma
  metninize eklemek) sizin sorumluluğunuzdadır.</p>

  <h4>5. Sorumluluk sınırlaması</h4>
  <p>İzinsiz arama/mesaj gönderimi, İYS ihlali veya KVKK'ya aykırı veri işleme
  nedeniyle tarafınıza veya üçüncü kişilere yönelik doğacak idari para cezası,
  şikayet, dava veya diğer her türlü yaptırımdan yalnızca <b>siz</b> sorumlusunuz.
  Şirket bu konuda herhangi bir garanti vermez ve söz konusu sonuçlardan
  sorumlu tutulamaz; gerekli hallerde doğacak zararı tazmin etmeyi kabul edersiniz.</p>

  <h4>6. Onay</h4>
  <p>Aşağıdaki kutuyu işaretleyip devam ettiğinizde, bu metni okuduğunuzu ve
  yukarıdaki sorumlulukları kabul ettiğinizi beyan etmiş olursunuz. Bu kabul,
  hesabınıza zaman damgası ve IP adresiyle birlikte kaydedilir.</p>
`;

function showTermsGate() {
  const root = document.createElement('div');
  root.id = 'termsGateOverlay';
  root.innerHTML = `
    <div class="terms-gate-box">
      <div class="terms-gate-header">📋 Kullanım Koşulları ve Sorumluluk Beyanı</div>
      <div class="terms-gate-body">${TERMS_TEXT_HTML}</div>
      <label class="terms-gate-checkbox">
        <input type="checkbox" id="termsGateCheckbox" />
        Yukarıdaki metni okudum, anladım ve kabul ediyorum.
      </label>
      <div class="terms-gate-actions">
        <button class="btn-secondary" id="termsGateLogout">Çıkış Yap</button>
        <button class="btn-start" id="termsGateAccept" disabled>Kabul Ediyorum, Devam Et</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const checkbox = root.querySelector('#termsGateCheckbox');
  const acceptBtn = root.querySelector('#termsGateAccept');
  checkbox.addEventListener('change', () => { acceptBtn.disabled = !checkbox.checked; });

  root.querySelector('#termsGateLogout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  });

  acceptBtn.addEventListener('click', async () => {
    acceptBtn.disabled = true;
    acceptBtn.textContent = 'Kaydediliyor...';
    try {
      const r = await fetch('/api/terms/accept', { method: 'POST' });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'Onay kaydedilemedi');
      location.reload();
    } catch (err) {
      acceptBtn.disabled = false;
      acceptBtn.textContent = 'Kabul Ediyorum, Devam Et';
      alert('Hata: ' + err.message);
    }
  });
}
