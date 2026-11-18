import { describe, expect, it } from 'vitest';
import { hideKeys, liveArgs } from './live';
import { validKey, validServer } from './destinationRules';

const targets = [
  { id: 'a', name: 'YouTube', url: 'rtmps://a.rtmps.youtube.com:443/live2/abcd-1234', key: 'abcd-1234' },
  { id: 'b', name: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-9?s_bl=1', key: 'FB-9?s_bl=1' },
];

describe('transmissão', () => {
  it('envia para todos os destinos e um que cair não derruba os outros', () => {
    const args = liveArgs({ width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'hardware' }, 'webm', targets);
    const tee = args[args.length - 1];
    expect(tee.split('|')).toHaveLength(2);
    expect(tee).toContain('[f=flv:onfail=ignore]rtmps://a.rtmps');
    expect(args).toContain('h264_videotoolbox');
    expect(args.join(' ')).toContain('-g 60');
  });
  it('programa já em H.264: repassa o vídeo sem codificar de novo (só o áudio vira AAC)', () => {
    const args = liveArgs({ width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'hardware' }, 'matroska', targets, true).join(' ');
    expect(args).toContain('-c:v copy');
    expect(args).not.toContain('h264_videotoolbox');
    expect(args).not.toContain('-vf');
    expect(args).toContain('-c:a aac');
  });
  it('replay: grava pedaços do mesmo vídeo como mais uma saída que não derruba a live', () => {
    const args = liveArgs({ width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'hardware' }, 'webm', targets, true, '/dados/Estúdio ao Vivo/replay-buffer/sessao-1');
    const tee = args[args.length - 1].split('|');
    expect(tee).toHaveLength(3);
    expect(tee[2]).toBe('[f=segment:segment_time=1:segment_format=mpegts:bsfs/v=h264_mp4toannexb:onfail=ignore]/dados/Estúdio ao Vivo/replay-buffer/sessao-1/seg%06d.ts');
    expect(liveArgs({ width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'hardware' }, 'webm', targets, true).at(-1)!.split('|')).toHaveLength(2);
  });
  it('nunca mostra a chave', () => {
    expect(hideKeys('Slave rtmps://x/live2/abcd-1234 failed', targets)).toBe('Slave rtmps://x/live2/•••• failed');
  });
  it('só aceita servidor RTMP e chave sem separadores', () => {
    expect(validServer('rtmps://a.rtmps.youtube.com:443/live2')).toBe(true);
    expect(validServer('https://x.com')).toBe(false);
    expect(validServer('rtmp://x|y')).toBe(false);
    expect(validKey('abcd efgh')).toBe(false);
    expect(validKey('abcd|efgh')).toBe(false);
    expect(validKey('xxxx-yyyy-zzzz')).toBe(true);
  });
});
