// Roleplay persona veri bütünlüğü — SAF veri testi (ağ/DB kullanmaz).
// Yeni persona eklenirken bir alan unutulursa (brifing, cinsiyet, prompt) burada
// yakalanır. Eksik alan sessiz bozulmalara yol açıyordu: cinsiyeti olmayan persona
// yanlış sesle konuşuyor, brifingi olmayan persona "Detayları Gör" modalını boş
// açıyordu.

import { test, expect } from '@playwright/test';
import { ROLEPLAY_PERSONAS, getRoleplayPersona } from '../../src/personas';

test.describe('Roleplay persona bütünlüğü', () => {
  test('her personanın zorunlu alanları dolu', () => {
    expect(ROLEPLAY_PERSONAS.length).toBeGreaterThan(0);

    for (const p of ROLEPLAY_PERSONAS) {
      expect(p.id, 'id zorunlu').toBeTruthy();
      expect(p.family, `${p.id}: family zorunlu`).toBeTruthy();
      expect(['kolay', 'orta', 'zor'], `${p.id}: geçersiz zorluk`).toContain(p.difficulty);
      expect(p.label, `${p.id}: label zorunlu`).toBeTruthy();

      // Açıklama kartta görünür — boş/çok kısa olursa danışman senaryoyu anlamaz.
      expect(p.description.length, `${p.id}: açıklama çok kısa`).toBeGreaterThan(20);

      // Prompt asistanın tüm davranışını belirler.
      expect(p.systemPrompt.length, `${p.id}: prompt çok kısa`).toBeGreaterThan(200);

      // Cinsiyet ses seçimini belirler — eksikse erkek karakter kadın sesiyle konuşur.
      expect(['kadin', 'erkek'], `${p.id}: geçersiz cinsiyet`).toContain(p.gender);
    }
  });

  test('her personanın brifingi eksiksiz', () => {
    for (const p of ROLEPLAY_PERSONAS) {
      const b = p.briefing;
      expect(b, `${p.id}: brifing yok`).toBeTruthy();
      expect(b.kisi, `${p.id}: brifing.kisi yok`).toBeTruthy();
      expect(Array.isArray(b.mulk) && b.mulk.length, `${p.id}: brifing.mulk boş`).toBeTruthy();
      expect(b.fiyat, `${p.id}: brifing.fiyat yok`).toBeTruthy();
      expect(b.durum, `${p.id}: brifing.durum yok`).toBeTruthy();
      expect(Array.isArray(b.itirazlar) && b.itirazlar.length, `${p.id}: itirazlar boş`).toBeTruthy();
      expect(b.hedef, `${p.id}: hedef yok`).toBeTruthy();
    }
  });

  test('id\'ler benzersiz ve lookup çalışıyor', () => {
    const ids = ROLEPLAY_PERSONAS.map(p => p.id);
    expect(new Set(ids).size, 'tekrarlayan persona id var').toBe(ids.length);

    // Arayüz personayı id ile çözüyor — lookup bozulursa "Pratiğe Başla" çalışmaz.
    for (const p of ROLEPLAY_PERSONAS) {
      expect(getRoleplayPersona(p.id)?.id, `${p.id}: lookup başarısız`).toBe(p.id);
    }
    expect(getRoleplayPersona('boyle-bir-persona-yok')).toBeUndefined();
  });

  test('her senaryo ailesinde üç zorluk seviyesi var', () => {
    const aileler = [...new Set(ROLEPLAY_PERSONAS.map(p => p.family))];
    expect(aileler.length).toBeGreaterThan(1);

    for (const aile of aileler) {
      const zorluklar = ROLEPLAY_PERSONAS
        .filter(p => p.family === aile)
        .map(p => p.difficulty)
        .sort();
      // Arayüz önce aile, sonra zorluk seçtiriyor — eksik zorluk boş ekran demek.
      expect(zorluklar, `${aile}: zorluk seviyeleri eksik`).toEqual(['kolay', 'orta', 'zor']);
    }
  });
});
