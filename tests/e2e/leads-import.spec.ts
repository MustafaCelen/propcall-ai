// CSV/Excel içe aktarma — çakışma tespiti + çözümü (güncelle/atla/yeni-oluştur).
// Dosya-upload UI etkileşimi yerine doğrudan preview/commit API'lerini test ediyoruz
// (asıl mantık backend'de — leads.ts previewImportConflicts/commitImportResolutions,
// bkz. src/leads.ts) — UI'daki dosya seçim/parse akışı ayrı, daha kırılgan bir katman.

import { test, expect } from '@playwright/test';
import { deleteLead } from '../helpers/apiHelpers';

test.describe('Aday içe aktarma — çakışma tespiti ve çözümü', () => {
  test('yeni + çakışan satırlar doğru ayrılır, commit ile update/create doğru uygulanır', async ({ request }) => {
    const phone = `+90555${Math.floor(1000000 + Math.random() * 8999999)}`;

    // 1) Önceden var olan bir aday oluştur (çakışmayı tetikleyecek) — mevcut bir
    // etiketle, import'un getirdiği etiketin bunu SİLMEDİĞİNİ (birleştirdiğini)
    // doğrulamak için.
    const existingRes = await request.post('/api/leads', {
      data: { firstName: 'Import Conflict Original', phone, tags: ['eski-etiket'] },
    });
    const existing = (await existingRes.json()).data;
    const newPhone = `+90555${Math.floor(1000000 + Math.random() * 8999999)}`;

    try {
      // 2) Aynı telefonla + yeni bir telefonla preview çağır.
      const previewRes = await request.post('/api/leads/import/preview', {
        data: {
          rows: [
            { name: 'Import Conflict Updated', phone, region: 'Istanbul' },
            { name: 'Brand New Lead', phone: newPhone, region: 'Ankara' },
          ],
        },
      });
      expect(previewRes.ok()).toBeTruthy();
      const preview = (await previewRes.json()).data;
      expect(preview.newRows).toHaveLength(1);
      expect(preview.conflicts).toHaveLength(1);
      expect(preview.conflicts[0].existingLead.id).toBe(existing.id);

      // 3) Commit — çakışanı güncelle, yeniyi oluştur.
      const commitRes = await request.post('/api/leads/import/commit', {
        data: {
          newRows: preview.newRows,
          resolutions: [{ row: preview.conflicts[0].row, existingLeadId: existing.id, action: 'update' }],
          importSource: 'e2e-test',
          tags: ['batch-etiketi'],
        },
      });
      expect(commitRes.ok()).toBeTruthy();
      const result = (await commitRes.json()).data;
      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);

      // 4) Güncellenen lead'in gerçekten değiştiğini VE eski etiketin korunup yeni
      // batch etiketiyle birleştiğini doğrula.
      const updatedRes = await request.get(`/api/leads/${existing.id}`);
      const updated = (await updatedRes.json()).data;
      expect(updated.region).toBe('Istanbul');
      expect(updated.tags.sort()).toEqual(['batch-etiketi', 'eski-etiket']);

      // Yeni oluşturulan lead de aynı batch etiketini almış olmalı.
      const listRes = await request.get('/api/leads');
      const created = (await listRes.json()).data.find((l: any) => l.phone === newPhone);
      expect(created.tags).toEqual(['batch-etiketi']);
    } finally {
      // Temizlik — commit yarı yolda patlasa bile import'un oluşturduğu adayı da bul ve sil.
      await deleteLead(request, existing.id);
      const leftover = ((await (await request.get('/api/leads')).json()).data as any[]).find((l: any) => l.phone === newPhone);
      if (leftover) await deleteLead(request, leftover.id);
    }
  });

  test('çakışma için "skip" seçilirse mevcut aday değişmeden kalır', async ({ request }) => {
    const phone = `+90555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const existingRes = await request.post('/api/leads', {
      data: { firstName: 'Skip Test Original', phone, notes: 'orijinal not' },
    });
    const existing = (await existingRes.json()).data;

    try {
      const previewRes = await request.post('/api/leads/import/preview', {
        data: { rows: [{ name: 'Skip Test Should Not Apply', phone, notes: 'yeni not' }] },
      });
      const preview = (await previewRes.json()).data;

      const commitRes = await request.post('/api/leads/import/commit', {
        data: {
          newRows: [],
          resolutions: [{ row: preview.conflicts[0].row, existingLeadId: existing.id, action: 'skip' }],
        },
      });
      const result = (await commitRes.json()).data;
      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);

      const afterRes = await request.get(`/api/leads/${existing.id}`);
      const after = (await afterRes.json()).data;
      expect(after.notes).toBe('orijinal not');
    } finally {
      await deleteLead(request, existing.id);
    }
  });
});
