import pool from './db';
import { Appointment } from './types';

export async function getAllAppointments(): Promise<Appointment[]> {
  const { rows } = await pool.query(
    `SELECT data FROM appointments ORDER BY data->>'date' ASC, data->>'time' ASC`,
  );
  return rows.map(r => r.data as Appointment);
}

export async function saveAppointment(
  data: Omit<Appointment, 'id' | 'createdAt'>,
): Promise<Appointment> {
  const appt: Appointment = {
    ...data,
    id:        `apt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };
  await pool.query(
    'INSERT INTO appointments (id, data) VALUES ($1, $2)',
    [appt.id, JSON.stringify(appt)],
  );
  return appt;
}

export async function deleteAppointment(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM appointments WHERE id = $1',
    [id],
  );
  return (rowCount ?? 0) > 0;
}
