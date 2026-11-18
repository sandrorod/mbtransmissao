import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Arquivo de chaves (canais do YouTube e destinos com as chaves de transmissão), protegido por senha:
 * AES-256-GCM com chave derivada da senha por scrypt. Sem a senha o conteúdo não pode ser lido nem alterado.
 */
const KIND = 'estudio-chaves';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const MIN_PASSWORD = 6;

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, SCRYPT);
}

export function sealKeys(data: unknown, password: string): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(password, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({ kind: KIND, version: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: body.toString('base64') }, null, 2);
}

export function openKeys(text: string, password: string): unknown {
  let file: { kind?: unknown; salt?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('Este arquivo não é um arquivo de chaves do Estúdio ao Vivo.');
  }
  if (!file || file.kind !== KIND || typeof file.salt !== 'string' || typeof file.iv !== 'string' || typeof file.tag !== 'string' || typeof file.data !== 'string') {
    throw new Error('Este arquivo não é um arquivo de chaves do Estúdio ao Vivo.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(String(password ?? ''), Buffer.from(file.salt, 'base64')), Buffer.from(file.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    throw new Error('Senha incorreta (ou o arquivo foi alterado).');
  }
}
