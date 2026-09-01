import pool from './db';
import { Appointment } from './types';

export async function getAllAppointments(userId: string): Promise<Appointment[]> {
  const { rows } = await pool.query(
    `SELECT data FROM appointments WHERE user_id = $1 ORDER BY data->>'date' ASC, data->>'time' ASC`,
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
    'INSERT INTO appointments (id, data, user_id) VALUES ($1, $2, $3)',
    [appt.id, JSON.stringify(appt), userId],
  );
  return appt;
}

export async function deleteAppointment(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM appointments WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

// Randevu → satış dönüşümü elle işaretlenir (bkz. Appointment.outcome yorumu) —
// jsonb_set ile tek sorguda güncellenir, ayrı bir okuma gerekmez.
export async function setAppointmentOutcome(
  userId: string, id: string, outcome: 'pending' | 'won' | 'lost', outcomeNote?: string,
): Promise<Appointment | null> {
  const { rows } = await pool.query(
    `UPDATE appointments
     SET data = data || jsonb_build_object('outcome', $3::text, 'outcomeNote', $4::text)
     WHERE id = $1 AND user_id = $2
     RETURNING data`,
    [id, userId, outcome, outcomeNote ?? null],
  );
  return rows[0] ? (rows[0].data as Appointment) : null;
}
