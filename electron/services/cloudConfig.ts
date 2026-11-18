import type { CloudConfig } from './account';

/**
 * Servidor das contas. A chave "anon" é pública por natureza:
 * quem protege os dados é o RLS (cada usuário só lê e grava a própria linha).
 */
const URL = process.env.OBS_CLOUD_URL ?? '';
const ANON_KEY = process.env.OBS_CLOUD_ANON_KEY ?? '';

export const CLOUD: CloudConfig | null = URL && ANON_KEY ? { url: URL, anonKey: ANON_KEY } : null;
