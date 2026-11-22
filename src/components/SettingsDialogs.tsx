import { useEffect, useMemo, useState } from 'react';
import { Ear } from 'lucide-react';
import { mixer } from '../audio/engine';
import { displayName, findDevice, type SystemDevice } from '../devices/identify';
import { usePooledStream } from '../devices/pool';
import { formatFps, formatSize, videoChoices } from '../devices/videoOptions';
import { ASPECTS, ROTATIONS, type AudioSettings, type DeviceRef, type Source, type VideoMode, type VideoSettings } from '../types/studio';
import { realDevices, refOf } from '../utils/project';
import { LevelBar, Modal, VideoView } from './common';
import { audioSpecOf, useLevel, videoSpecOf } from './DevicesPanel';

const ASPECT_LABEL: Record<string, string> = { original: 'Original do dispositivo', '16:9': '16:9', '4:3': '4:3', '1:1': '1:1 (quadrado)', '9:16': '9:16 (vertical)' };

/** Parâmetros que algumas câmeras expõem; só aparecem os que a câmera conectada informa. */
const CAMERA_PARAMS: Record<string, string> = {
  zoom: 'Zoom',
  pan: 'Pan',
  tilt: 'Tilt',
  brightness: 'Brilho',
  contrast: 'Contraste',
  saturation: 'Saturação',
  sharpness: 'Nitidez',
  exposureCompensation: 'Compensação de exposição',
  exposureTime: 'Tempo de exposição',
  colorTemperature: 'Temperatura de cor',
  focusDistance: 'Distância de foco',
};

function DeviceField({ value, devices, kind, onChange }: { value: DeviceRef; devices: SystemDevice[]; kind: SystemDevice['kind']; onChange: (ref: DeviceRef) => void }) {
  const list = realDevices(devices, kind);
  const current = findDevice(value, devices, kind);
  return (
    <label className="option-field">
      <span className="option-label">Dispositivo</span>
      <select className={`option-select ${current ? '' : 'select-missing'}`} value={current?.deviceId ?? '__missing'} onChange={(e) => {
        const device = list.find((d) => d.deviceId === e.target.value);
        if (device) onChange(refOf(device));
      }}>
        {!current && <option value="__missing" disabled>{displayName(value.label)} (desconectado)</option>}
        {list.map((d) => <option key={d.deviceId} value={d.deviceId}>{displayName(d.label)}</option>)}
      </select>
    </label>
  );
}

type Range = { min?: number; max?: number; step?: number };

/** Papel do dispositivo no Programa (master / sobreposição); null = não se aplica (widget, mídia). */
export interface ProgramRole {
  master: boolean;
  overlay: boolean;
  onMaster: (on: boolean) => void;
  onOverlay: (on: boolean) => void;
}

export function VideoSettingsDialog({ source, program, devices, modes, onChange, onDevice, onClose }: {
  source: Source;
  program?: ProgramRole | null;
  devices: SystemDevice[];
  modes: VideoMode[] | null | undefined;
  onChange: (patch: Partial<VideoSettings>) => void;
  onDevice: (ref: DeviceRef) => void;
  onClose: () => void;
}) {
  const settings = source.video!;
  const pooled = usePooledStream(findDevice(source.device, devices, 'videoinput') ? videoSpecOf(source) : null);
  const track = pooled.stream?.getVideoTracks()[0];
  const caps = useMemo(() => track?.getCapabilities?.() as (MediaTrackCapabilities & Record<string, Range | unknown>) | undefined, [track]);
  const actual = track?.getSettings();
  const choices = videoChoices(modes ?? null, caps ? { width: caps.width as Range, height: caps.height as Range, frameRate: caps.frameRate as Range } : null);
  const sizeValue = settings.width ? `${settings.width}x${settings.height}` : '';
  const fpsList = settings.width ? choices.fpsFor(settings.width, settings.height) : [...new Set(choices.sizes.flatMap((s) => choices.fpsFor(s.width, s.height)))].sort((a, b) => b - a);
  const params = Object.entries(CAMERA_PARAMS).filter(([key]) => {
    const range = caps?.[key] as Range | undefined;
    return range && typeof range.max === 'number' && typeof range.min === 'number' && range.max > range.min;
  });

  return (
    <Modal title={`Configurações de vídeo · ${displayName(source.name)}`} onClose={onClose} wide>
      <div className="settings-layout">
        <div className="settings-preview">
          <div className="screen"><VideoView pooled={pooled} settings={settings} label={source.device.label} /></div>
          <p className="hint">
            {actual?.width ? `Capturando ${actual.width}×${actual.height}${actual.frameRate ? ` a ${Math.round(actual.frameRate * 100) / 100} fps` : ''}.` : 'Aguardando imagem…'}
            {' '}{choices.source === 'avfoundation' ? 'Opções lidas do próprio dispositivo pelo macOS.' : choices.source === 'capacidades' ? 'Opções dentro dos limites que a câmera informa.' : ''}
          </p>
        </div>
        <div className="settings-form">
          <DeviceField value={source.device} devices={devices} kind="videoinput" onChange={onDevice} />
          {program && (
            <>
              <h3 className="group-title">No Programa</h3>
              <label className="switch-row" title="Quando o Programa ficar sem nenhuma câmera ou celular (caiu, congelou ou foi tirado), este entra na hora">
                <span>Dispositivo master<small className="switch-hint">Assume o Programa quando ele fica sem câmera. Só um por vez.</small></span>
                <input type="checkbox" className="switch" checked={program.master} onChange={(e) => program.onMaster(e.target.checked)} />
              </label>
              <label className="switch-row" title="Ao mandar para o Programa, entra por cima sem tirar quem está no ar">
                <span>Sobreposição<small className="switch-hint">Entra por cima do que está no ar, sem tirar. Sem esta opção, mandar para o Programa troca a câmera que estava.</small></span>
                <input type="checkbox" className="switch" checked={program.overlay} onChange={(e) => program.onOverlay(e.target.checked)} />
              </label>
            </>
          )}
          {choices.sizes.length > 0 && (
            <label className="option-field">
              <span className="option-label">Resolução</span>
              <select className="option-select" value={sizeValue} onChange={(e) => {
                if (!e.target.value) return onChange({ width: 0, height: 0, fps: 0 });
                const [width, height] = e.target.value.split('x').map(Number);
                const fps = choices.fpsFor(width, height);
                onChange({ width, height, fps: fps.includes(settings.fps) ? settings.fps : fps[0] ?? 0 });
              }}>
                <option value="">Automática</option>
                {choices.sizes.map((s) => <option key={`${s.width}x${s.height}`} value={`${s.width}x${s.height}`}>{formatSize(s)}</option>)}
              </select>
            </label>
          )}
          {fpsList.length > 0 && (
            <label className="option-field">
              <span className="option-label">Taxa de quadros</span>
              <select className="option-select" value={settings.fps || ''} onChange={(e) => onChange({ fps: Number(e.target.value) || 0 })}>
                <option value="">Automática</option>
                {fpsList.map((f) => <option key={f} value={f}>{formatFps(f)}</option>)}
              </select>
            </label>
          )}
          <div className="option-field">
            <span className="option-label">Formato de vídeo</span>
            <p className="hint">Escolhido pelo macOS conforme a resolução e a taxa (o motor de captura não permite trocar o formato de pixel).</p>
          </div>
          <label className="option-field">
            <span className="option-label">Proporção</span>
            <select className="option-select" value={settings.aspect} onChange={(e) => onChange({ aspect: e.target.value as VideoSettings['aspect'] })}>
              {ASPECTS.map((a) => <option key={a} value={a}>{ASPECT_LABEL[a]}</option>)}
            </select>
          </label>
          <label className="option-field">
            <span className="option-label">Orientação</span>
            <select className="option-select" value={settings.rotation} onChange={(e) => onChange({ rotation: Number(e.target.value) as VideoSettings['rotation'] })}>
              {ROTATIONS.map((r) => <option key={r} value={r}>{r === 0 ? 'Normal' : `Girar ${r}°`}</option>)}
            </select>
          </label>
          <label className="switch-row">
            <span>Espelhar imagem</span>
            <input type="checkbox" className="switch" checked={settings.mirror} onChange={(e) => onChange({ mirror: e.target.checked })} />
          </label>
          {params.length > 0 && <h3 className="group-title">Parâmetros de captura</h3>}
          {params.map(([key, label]) => {
            const range = caps![key] as Range;
            const value = settings.extra[key] ?? (actual as Record<string, unknown> | undefined)?.[key] as number ?? range.min!;
            return (
              <label key={key} className="option-field">
                <span className="option-label">{label} <output>{Math.round(value * 100) / 100}</output></span>
                <input type="range" min={range.min} max={range.max} step={range.step || (range.max! - range.min!) / 100} value={value} onChange={(e) => onChange({ extra: { ...settings.extra, [key]: Number(e.target.value) } })} />
              </label>
            );
          })}
          {params.length > 0 && Object.keys(settings.extra).length > 0 && <button type="button" className="link-btn" onClick={() => onChange({ extra: {} })}>Voltar parâmetros ao padrão da câmera</button>}
        </div>
      </div>
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Concluir</button></div>
    </Modal>
  );
}

const SAMPLE_RATES = [32000, 44100, 48000, 88200, 96000, 192000];

export function AudioSettingsDialog({ source, devices, onChange, onDevice, onClose }: {
  source: Source;
  devices: SystemDevice[];
  onChange: (patch: Partial<AudioSettings>) => void;
  onDevice: (ref: DeviceRef) => void;
  onClose: () => void;
}) {
  const settings = source.audio!;
  const pooled = usePooledStream(findDevice(source.device, devices, 'audioinput') ? audioSpecOf(source) : null);
  const read = useLevel(pooled.stream);
  const track = pooled.stream?.getAudioTracks()[0];
  const caps = useMemo(() => track?.getCapabilities?.() as (MediaTrackCapabilities & { channelCount?: Range; sampleRate?: Range }) | undefined, [track]);
  const actual = track?.getSettings();
  const channels = caps?.channelCount?.max ?? actual?.channelCount ?? 1;
  const rates = SAMPLE_RATES.filter((r) => (caps?.sampleRate?.min ?? Infinity) <= r && r <= (caps?.sampleRate?.max ?? 0));
  const supports = (key: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl') => Array.isArray(caps?.[key]) && (caps![key] as boolean[]).includes(true);
  const listening = settings.monitor;
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    mixer.listen(testing ? pooled.stream : null);
  }, [testing, pooled.stream]);
  useEffect(() => () => mixer.listen(null), []);

  return (
    <Modal title={`Configurações de áudio · ${displayName(source.name)}`} onClose={onClose}>
      <div className="settings-form">
        <DeviceField value={source.device} devices={devices} kind="audioinput" onChange={onDevice} />
        <div className="option-field">
          <span className="option-label">Sinal de entrada {actual?.sampleRate ? `· ${(actual.sampleRate / 1000).toLocaleString('pt-BR')} kHz · ${actual.channelCount ?? channels} ${(actual.channelCount ?? channels) === 1 ? 'canal' : 'canais'}` : ''}</span>
          <LevelBar read={read} />
          {pooled.error && <p className="device-error">{pooled.error}</p>}
          <button type="button" className={`btn btn-small test-button ${testing ? 'btn-on' : ''}`} disabled={!pooled.stream} onClick={() => setTesting(!testing)}>
            <Ear size={13} /> {testing ? 'Parar teste' : 'Testar ouvindo no monitoramento'}
          </button>
        </div>
        {channels > 1 && (
          <label className="option-field">
            <span className="option-label">Canal de áudio</span>
            <select className="option-select" value={String(settings.channel)} onChange={(e) => onChange({ channel: e.target.value === 'all' ? 'all' : Number(e.target.value) })}>
              <option value="all">Todos os canais</option>
              {Array.from({ length: channels }, (_, i) => <option key={i} value={i}>Só o canal {i + 1} (mono)</option>)}
            </select>
          </label>
        )}
        {rates.length > 1 && (
          <label className="option-field">
            <span className="option-label">Frequência de amostragem</span>
            <select className="option-select" value={settings.sampleRate || ''} onChange={(e) => onChange({ sampleRate: Number(e.target.value) || 0 })}>
              <option value="">Do dispositivo</option>
              {rates.map((r) => <option key={r} value={r}>{(r / 1000).toLocaleString('pt-BR')} kHz</option>)}
            </select>
          </label>
        )}
        {channels > 1 && settings.channel === 'all' && (
          <label className="switch-row">
            <span>Estéreo <small>Desligado = mistura os canais em mono</small></span>
            <input type="checkbox" className="switch" checked={settings.stereo} onChange={(e) => onChange({ stereo: e.target.checked })} />
          </label>
        )}
        <label className="option-field">
          <span className="option-label">Volume de entrada <output>{Math.round(settings.volume * 100)}%</output></span>
          <input type="range" min={0} max={2} step={0.01} value={settings.volume} onChange={(e) => onChange({ volume: Number(e.target.value) })} />
        </label>
        <label className="switch-row">
          <span>Monitoramento <small>Ouvir esta fonte na saída de monitoramento</small></span>
          <input type="checkbox" className="switch" checked={listening} onChange={(e) => onChange({ monitor: e.target.checked })} />
        </label>
        <h3 className="group-title">Filtros</h3>
        {supports('noiseSuppression') && (
          <label className="switch-row"><span>Redução de ruído</span><input type="checkbox" className="switch" checked={settings.noiseSuppression} onChange={(e) => onChange({ noiseSuppression: e.target.checked })} /></label>
        )}
        {supports('echoCancellation') && (
          <label className="switch-row"><span>Cancelamento de eco</span><input type="checkbox" className="switch" checked={settings.echoCancellation} onChange={(e) => onChange({ echoCancellation: e.target.checked })} /></label>
        )}
        {supports('autoGainControl') && (
          <label className="switch-row"><span>Ganho automático</span><input type="checkbox" className="switch" checked={settings.autoGainControl} onChange={(e) => onChange({ autoGainControl: e.target.checked })} /></label>
        )}
        <label className="switch-row"><span>Corte de graves <small>Abaixo de 80 Hz: vento, vibração, ronco de palco</small></span><input type="checkbox" className="switch" checked={settings.highPass} onChange={(e) => onChange({ highPass: e.target.checked })} /></label>
      </div>
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Concluir</button></div>
    </Modal>
  );
}
