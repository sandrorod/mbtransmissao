/** O que a situação da live no YouTube significa para quem está transmitindo. */

/** Situações em que a live não recebe mais vídeo: quem abre o link vê "ocorreu um erro". */
export const ENDED = new Set(['complete', 'revoked']);

export function endedMessage(title: string, status: string | null): string {
  const what = status === null ? 'foi apagada no YouTube' : 'já terminou no YouTube';
  return `A live "${title}" ${what} e não recebe mais vídeo (o link dela mostra "ocorreu um erro"). Em ⚙️ Transmissão → Conta do YouTube, crie uma live nova (ou escolha outra) e clique em "Usar esta".`;
}

/** Mensagem curta para a tela enquanto transmite. */
export function liveMessage(title: string, status: string | null): string | null {
  if (status === 'live') return `No ar no YouTube: "${title}".`;
  if (status === 'testing' || status === 'testStarting' || status === 'ready' || status === 'liveStarting' || status === 'created') return `O YouTube está recebendo o vídeo; a live "${title}" está começando…`;
  if (status === null || ENDED.has(status)) return `O YouTube encerrou a live "${title}": quem abrir o link verá erro. Encerre e crie outra live para continuar.`;
  return null;
}
