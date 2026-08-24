import pool from './db';
import { Scenario } from './types';

export async function getAllScenarios(userId: string): Promise<Scenario[]> {
  const { rows } = await pool.query(
    `SELECT data FROM scenarios WHERE user_id = $1 ORDER BY data->>'createdAt' ASC`,
    [userId],
  );
  return rows.map(r => r.data as Scenario);
}

export async function getScenario(userId: string, id: string): Promise<Scenario | null> {
  const { rows } = await pool.query(
    'SELECT data FROM scenarios WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows[0]?.data ?? null;
}

export async function createScenario(userId: string, name: string, systemPrompt: string): Promise<Scenario> {
  const scenario: Scenario = {
    id:           `sc_${Date.now()}`,
    name:         name.trim(),
    systemPrompt,
    createdAt:    new Date().toISOString(),
  };
  await pool.query(
    'INSERT INTO scenarios (id, data, user_id) VALUES ($1, $2, $3)',
    [scenario.id, JSON.stringify(scenario), userId],
  );
  return scenario;
}

export async function updateScenario(
  userId: string,
  id: string,
  name: string,
  systemPrompt: string,
): Promise<Scenario | null> {
  const { rows } = await pool.query('SELECT data FROM scenarios WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) return null;
  const updated: Scenario = {
    ...rows[0].data,
    name: name.trim(),
    systemPrompt,
    updatedAt: new Date().toISOString(),
  };
  await pool.query(
    'UPDATE scenarios SET data = $1 WHERE id = $2 AND user_id = $3',
    [JSON.stringify(updated), id, userId],
  );
  return updated;
}

export async function deleteScenario(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM scenarios WHERE id = $1 AND user_id = $2', [id, userId]);
  return (rowCount ?? 0) > 0;
}
