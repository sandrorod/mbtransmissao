import { useEffect, useMemo } from 'react';
import { Headphones, Settings2, Volume2, VolumeX } from 'lucide-react';
import { mixer } from '../audio/engine';
import { displayName } from '../devices/identify';
import { usePooledStream } from '../devices/pool';
import type { AudioSettings, Source } from '../types/studio';
import { LevelBar } from './common';
import { audioSpecOf, isMedia, isPage, videoSpecOf } from './DevicesPanel';

function Channel({ source, hidden, onChange, onSettings }: { source: Source; hidden: boolean; onChange: (patch: Partial<AudioSettings>) => void; onSettings?: () => void }) {
  // Widget: o som vem da mesma captura da imagem (já aberta para o programa), não abre nada novo.
  // Vídeo da área Mídias: igual, o som vem da mesma captura da imagem.
  const web = isPage(source.device.deviceId) || isMedia(source.device.deviceId);
  const pooled = usePooledStream(web ? videoSpecOf(source) : audioSpecOf(source));
  const stream = useMemo(() => {
    if (!web || !pooled.stream) return pooled.stream;
    const tracks = pooled.stream.getAudioTracks();
    return tracks.length ? new MediaStream(tracks) : null;
  }, [web, pooled.stream]);
  const settings = source.audio!;
  // Widget escondido no programa não toca na live.
  const effective = useMemo(() => (hidden ? { ...settings, muted: true } : settings), [hidden, settings]);
  useEffect(() => {
    mixer.update(source.id, stream, effective);
  }, [source.id, stream, effective]);
  useEffect(() => () => mixer.remove(source.id), [source.id]);
  const db = settings.volume > 0 ? 20 * Math.log10(settings.volume) : -Infinity;
  return (
    <li className={`channel ${pooled.status === 'desconectado' || pooled.status === 'falhou' ? 'channel-lost' : ''}`} data-testid="mixer-channel">
      <div className="channel-head">
        <span className="channel-name" title={source.device.label}>{displayName(source.name)}</span>
        {pooled.status === 'desconectado' && <span className="status-tag status-desconectado"><i />Sem sinal</span>}
        {pooled.status === 'falhou' && <span className="status-tag status-falhou" title={pooled.error ?? ''}><i />Falhou</span>}
        {web && hidden && <span className="status-tag" title="O widget está oculto no programa: o som dele não vai para a live."><i />Oculto</span>}
        {web && pooled.stream && !stream && <span className="status-tag status-falhou" title="A captura desta página veio sem som. Reabra o widget."><i />Sem som</span>}
        {onSettings && <button type="button" className="icon-btn" aria-label={`Configurar ${source.name}`} title="Configurações" onClick={onSettings}><Settings2 size={13} /></button>}
      </div>
      <LevelBar read={() => mixer.peak(source.id)} />
      <div className="channel-controls">
        <button type="button" className={`icon-btn ${settings.muted ? 'icon-btn-danger' : ''}`} aria-label={settings.muted ? 'Ativar som' : 'Silenciar'} title={settings.muted ? 'Ativar som' : 'Silenciar'} onClick={() => onChange({ muted: !settings.muted })}>
          {settings.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <input type="range" min={0} max={2} step={0.01} value={settings.volume} aria-label={`Volume de ${source.name}`} onChange={(e) => onChange({ volume: Number(e.target.value) })} onDoubleClick={() => onChange({ volume: 1 })} title="Duplo clique volta para 0 dB" />
        <output className="channel-db">{Number.isFinite(db) ? `${db > 0 ? '+' : ''}${db.toFixed(1).replace('.', ',')} dB` : '−∞'}</output>
        <button type="button" className={`icon-btn ${settings.monitor ? 'icon-btn-on' : ''}`} aria-label="Monitorar" title={settings.monitor ? 'Parar de monitorar' : 'Ouvir no monitoramento'} onClick={() => onChange({ monitor: !settings.monitor })}><Headphones size={15} /></button>
      </div>
    </li>
  );
}

export function MixerPanel({ sources, hiddenIds, onChange, onSettings }: { sources: Source[]; hiddenIds: Set<string>; onChange: (id: string, patch: Partial<AudioSettings>) => void; onSettings: (source: Source) => void }) {
  return (
    <section className="panel" aria-label="Mixer de áudio">
      <header className="panel-head">
        <h2 className="panel-title">Mixer</h2>
      </header>
      <div className="channel master" title="Mix do programa">
        <div className="channel-head"><span className="channel-name">Programa (master)</span></div>
        <LevelBar read={() => mixer.masterPeak()} />
      </div>
      {sources.length === 0 && <p className="empty-text">Nenhuma fonte de áudio na cena ativa.</p>}
      <ul className="channel-list">
        {sources.map((source) => (
          <Channel key={source.id} source={source} hidden={hiddenIds.has(source.id)} onChange={(patch) => onChange(source.id, patch)} onSettings={isPage(source.device.deviceId) ? undefined : () => onSettings(source)} />
        ))}
      </ul>
    </section>
  );
}
