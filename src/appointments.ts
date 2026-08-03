import pool from './db';
import { Appointment } from './types';

// TÜM FONKSİYONLAR user_id ZORUNLU — çapraz erişim yok.

export async function getAllAppointments(userId: string): Promise<Appointment[]> {
  const { rows } = await pool.query(
    `SELECT data FROM appointments WHERE user_id = $1
     ORDER BY data->>'date' ASC, data->>'time' ASC`,
    [userId],
  );
  return rows.map(r => r.data as Appointment);
}

export async function saveAppointment(
  userId: string,
  data: Omit<Appointment, 'id' | 'createdAt'>,
): Promise<Appointment> {
  const appt: Appointment = {
    ...data,
    id:        `apt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };
  await pool.query(
    'INSERT INTO appointments (id, user_id, data) VALUES ($1, $2, $3)',
    [appt.id, userId, JSON.stringify(appt)],
  );
  return appt;
}

// user_id filter → başkasının randevusunu silemez
export async function deleteAppointment(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM appointments WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}
