import { describe, expect, it } from 'vitest';
import { ENDED, endedMessage, liveMessage } from './youtubeStatus';

describe('situação da live no YouTube', () => {
  it('live terminada ou apagada bloqueia a transmissão com o que fazer', () => {
    expect(ENDED.has('complete')).toBe(true);
    expect(ENDED.has('live')).toBe(false);
    expect(endedMessage('JJ', 'complete')).toMatch(/"JJ" já terminou.*crie uma live nova/);
    expect(endedMessage('JJ', null)).toMatch(/foi apagada/);
  });
  it('mensagens durante a transmissão', () => {
    expect(liveMessage('JJ', 'live')).toMatch(/No ar no YouTube/);
    expect(liveMessage('JJ', 'ready')).toMatch(/começando/);
    expect(liveMessage('JJ', 'complete')).toMatch(/encerrou/);
  });
});
