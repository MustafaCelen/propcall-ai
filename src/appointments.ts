// PropCall AI - Randevu kayıt ve listeleme modülü

import fs from 'fs';
import path from 'path';
import { Appointment } from './types';

const DATA_FILE = path.join(__dirname, '..', 'data', 'appointments.json');

// Dosyadan randevuları oku
function readAppointments(): Appointment[] {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
      return [];
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw) as Appointment[];
  } catch (error) {
    console.error('[Randevu] Dosya okuma hatası:', error);
    return [];
  }
}

// Randevuları dosyaya yaz
function writeAppointments(appointments: Appointment[]): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(appointments, null, 2), 'utf-8');
  } catch (error) {
    console.error('[Randevu] Dosya yazma hatası:', error);
    throw new Error('Randevu kaydedilemedi');
  }
}

// Tüm randevuları getir
export function getAllAppointments(): Appointment[] {
  return readAppointments();
}

// Yeni randevu kaydet
export function saveAppointment(data: Omit<Appointment, 'id' | 'createdAt'>): Appointment {
  const appointments = readAppointments();

  const newAppointment: Appointment = {
    ...data,
    id: `apt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };

  appointments.push(newAppointment);
  writeAppointments(appointments);

  return newAppointment;
}

// Randevu sil
export function deleteAppointment(id: string): boolean {
  const appointments = readAppointments();
  const index = appointments.findIndex((a) => a.id === id);

  if (index === -1) return false;

  appointments.splice(index, 1);
  writeAppointments(appointments);
  return true;
}
