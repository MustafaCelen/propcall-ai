import pool from './db';
import { Scenario } from './types';

export async function getAllScenarios(): Promise<Scenario[]> {
  const { rows } = await pool.query(
    `SELECT data FROM scenarios ORDER BY data->>'createdAt' ASC`,
  );
  return rows.map(r => r.data as Scenario);
}

export async function getScenario(id: string): Promise<Scenario | null> {
  const { rows } = await pool.query(
    'SELECT data FROM scenarios WHERE id = $1',
    [id],
  );
  return rows[0]?.data ?? null;
}

export async function createScenario(name: string, systemPrompt: string): Promise<Scenario> {
  const scenario: Scenario = {
    id:           `sc_${Date.now()}`,
    name:         name.trim(),
    systemPrompt,
    createdAt:    new Date().toISOString(),
  };
  await pool.query(
    'INSERT INTO scenarios (id, data) VALUES ($1, $2)',
    [scenario.id, JSON.stringify(scenario)],
  );
  return scenario;
}

export async function updateScenario(
  id: string,
  name: string,
  systemPrompt: string,
): Promise<Scenario | null> {
  const { rows } = await pool.query('SELECT data FROM scenarios WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const updated: Scenario = {
    ...rows[0].data,
    name: name.trim(),
    systemPrompt,
    updatedAt: new Date().toISOString(),
  };
  await pool.query(
    'UPDATE scenarios SET data = $1 WHERE id = $2',
    [JSON.stringify(updated), id],
  );
  return updated;
}

export async function deleteScenario(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM scenarios WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
