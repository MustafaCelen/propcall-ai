// PropCall AI - Senaryo yönetimi

import fs from 'fs';
import path from 'path';
import { Scenario } from './types';

const FILE = path.join(__dirname, '..', 'data', 'scenarios.json');

function load(): Scenario[] {
  if (!fs.existsSync(FILE)) return [];
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
  catch { return []; }
}

function save(list: Scenario[]): void {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf-8');
}

export function getAllScenarios(): Scenario[] {
  return load();
}

export function getScenario(id: string): Scenario | null {
  return load().find(s => s.id === id) || null;
}

export function createScenario(name: string, systemPrompt: string): Scenario {
  const list = load();
  const scenario: Scenario = {
    id: `sc_${Date.now()}`,
    name: name.trim(),
    systemPrompt,
    createdAt: new Date().toISOString(),
  };
  list.push(scenario);
  save(list);
  return scenario;
}

export function updateScenario(id: string, name: string, systemPrompt: string): Scenario | null {
  const list = load();
  const idx  = list.findIndex(s => s.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], name: name.trim(), systemPrompt, updatedAt: new Date().toISOString() };
  save(list);
  return list[idx];
}

export function deleteScenario(id: string): boolean {
  const list = load();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}
