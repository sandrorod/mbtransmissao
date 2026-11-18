import { ChevronDown, ChevronRight, Plus, Star } from 'lucide-react';
import { displayName, findDevice, kindOf, type SystemDevice } from '../devices/identify';
import { ROLES, type DeviceRef, type Preferences, type Project, type Role } from '../types/studio';
import { realDevices, refOf } from '../utils/project';

function DeviceSelect({ label, value, devices, kind, empty, onChange }: {
  label: string;
  value: DeviceRef | null | undefined;
  devices: SystemDevice[];
  kind: SystemDevice['kind'];
  empty: string;
  onChange: (ref: DeviceRef | null) => void;
}) {
  const list = realDevices(devices, kind);
  const current = value ? findDevice(value, devices, kind) : null;
  // Guardado mas desligado: continua aparecendo, marcado, para o operador decidir.
  const missing = value && !current;
  return (
    <select
      className={`option-select ${missing ? 'select-missing' : ''}`}
      aria-label={label}
      value={current?.deviceId ?? (missing ? '__missing' : '')}
      onChange={(e) => {
        const device = list.find((d) => d.deviceId === e.target.value);
        onChange(device ? refOf(device) : null);
      }}
    >
      <option value="">{empty}</option>
      {missing && <option value="__missing" disabled>{displayName(value!.label)} (desconectado)</option>}
      {list.map((d) => <option key={d.deviceId} value={d.deviceId}>{displayName(d.label) || 'Sem nome'}</option>)}
    </select>
  );
}

interface Props {
  project: Project;
  prefs: Preferences;
  devices: SystemDevice[];
  activeSceneName: string | null;
  onRole: (role: Role, ref: DeviceRef | null) => void;
  onAddRoleToScene: (role: Role) => void;
  onMonitor: (ref: DeviceRef | null) => void;
  onPrefs: (prefs: Preferences) => void;
}

/** Recolhido por padrão: um clique no título abre ou fecha (e o app lembra). */
export function SelectionPanel({ project, prefs, devices, activeSceneName, onRole, onAddRoleToScene, onMonitor, onPrefs }: Props) {
  const isDefault = (role: Role) => {
    const ref = project.roles[role];
    const pref = role === 'camera' ? prefs.camera : role === 'microphone' ? prefs.microphone : null;
    return Boolean(ref && pref && findDevice(pref, devices, kindOf(ROLES[role].kind))?.deviceId === findDevice(ref, devices, kindOf(ROLES[role].kind))?.deviceId);
  };
  return (
    <section className="panel" aria-label="Seleção para a transmissão">
      <button type="button" className="panel-head panel-toggle" aria-expanded={prefs.selectionOpen} onClick={() => onPrefs({ ...prefs, selectionOpen: !prefs.selectionOpen })}>
        <h2 className="panel-title">Seleção para a transmissão</h2>
        {prefs.selectionOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {prefs.selectionOpen && (
      <>
      <div className="role-grid">
        {(Object.keys(ROLES) as Role[]).map((role) => {
          const kind = kindOf(ROLES[role].kind);
          return (
            <div key={role} className="role">
              <span className="option-label">{ROLES[role].label}</span>
              <div className="role-row">
                <DeviceSelect label={ROLES[role].label} value={project.roles[role]} devices={devices} kind={kind} empty="Nenhum" onChange={(ref) => onRole(role, ref)} />
                <button type="button" className="icon-btn" disabled={!project.roles[role] || !activeSceneName} title={activeSceneName ? `Adicionar à cena ${activeSceneName}` : 'Sem cena ativa'} aria-label={`Adicionar ${ROLES[role].label} à cena`} onClick={() => onAddRoleToScene(role)}><Plus size={15} /></button>
                {(role === 'camera' || role === 'microphone') && (
                  <button
                    type="button"
                    className={`icon-btn ${isDefault(role) ? 'icon-btn-on' : ''}`}
                    disabled={!project.roles[role]}
                    title={isDefault(role) ? 'Este é o padrão deste computador' : 'Usar como padrão neste computador'}
                    aria-label={`Definir ${ROLES[role].label} padrão`}
                    onClick={() => onPrefs({ ...prefs, [role]: project.roles[role] ?? null })}
                  >
                    <Star size={15} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div className="role">
          <span className="option-label">Monitoramento (fone/saída)</span>
          <DeviceSelect label="Monitoramento" value={project.monitorOutput} devices={devices} kind="audiooutput" empty="Saída padrão do macOS" onChange={onMonitor} />
        </div>
      </div>

      <details className="defaults">
        <summary>Dispositivos padrão deste computador</summary>
        <p className="hint">Usados ao criar um projeto e como primeira opção quando um dispositivo salvo não for encontrado.</p>
        <div className="role-grid">
          <div className="role"><span className="option-label">Câmera padrão</span><DeviceSelect label="Câmera padrão" value={prefs.camera} devices={devices} kind="videoinput" empty="Nenhuma" onChange={(camera) => onPrefs({ ...prefs, camera })} /></div>
          <div className="role"><span className="option-label">Microfone padrão</span><DeviceSelect label="Microfone padrão" value={prefs.microphone} devices={devices} kind="audioinput" empty="Nenhum" onChange={(microphone) => onPrefs({ ...prefs, microphone })} /></div>
          <div className="role"><span className="option-label">Interface de áudio padrão</span><DeviceSelect label="Interface de áudio padrão" value={prefs.audioInterface} devices={devices} kind="audioinput" empty="Nenhuma" onChange={(audioInterface) => onPrefs({ ...prefs, audioInterface })} /></div>
          <div className="role"><span className="option-label">Monitoramento padrão</span><DeviceSelect label="Monitoramento padrão" value={prefs.monitorOutput} devices={devices} kind="audiooutput" empty="Saída padrão do macOS" onChange={(monitorOutput) => onPrefs({ ...prefs, monitorOutput })} /></div>
        </div>
      </details>
      </>
      )}
    </section>
  );
}
