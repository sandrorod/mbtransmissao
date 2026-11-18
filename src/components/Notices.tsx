import { useState } from 'react';
import { CircleAlert, CircleCheck, Plug, Unplug, X } from 'lucide-react';
import { displayName, type SystemDevice } from '../devices/identify';
import type { DeviceRef, MediaAccess } from '../types/studio';
import type { MissingItem } from '../utils/project';
import { realDevices, refOf } from '../utils/project';
import { Modal } from './common';

export interface Toast {
  id: number;
  tone: 'ok' | 'warn' | 'error';
  icon: 'plug' | 'unplug' | 'ok' | 'alert';
  title: string;
  text?: string;
  action?: { label: string; run: () => void };
  /** Avisos de falha ficam até o operador fechar; os outros somem sozinhos. */
  sticky?: boolean;
}

const ICONS = { plug: Plug, unplug: Unplug, ok: CircleCheck, alert: CircleAlert };

export function Toasts({ toasts, onClose }: { toasts: Toast[]; onClose: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.icon];
        return (
          <div key={t.id} className={`toast toast-${t.tone}`} data-testid="toast">
            <Icon size={16} className="toast-icon" />
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.text && <span>{t.text}</span>}
              {t.action && <button type="button" className="link-btn" onClick={() => { t.action!.run(); onClose(t.id); }}>{t.action.label}</button>}
            </div>
            <button type="button" className="icon-btn" aria-label="Fechar aviso" onClick={() => onClose(t.id)}><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

/** Ao abrir um projeto: o que não foi encontrado, com um substituto para escolher (ou aguardar o aparelho voltar). */
export function MissingDevicesDialog({ items, devices, suggest, onApply, onClose }: {
  items: MissingItem[];
  devices: SystemDevice[];
  suggest: (item: MissingItem) => DeviceRef | null;
  onApply: (choices: Record<string, DeviceRef>) => void;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, suggest(i)?.deviceId ?? ''])));
  const apply = () => {
    const result: Record<string, DeviceRef> = {};
    for (const item of items) {
      const device = realDevices(devices, item.kind).find((d) => d.deviceId === choices[item.id]);
      if (device) result[item.id] = refOf(device);
    }
    onApply(result);
  };
  return (
    <Modal title="Dispositivos não encontrados" onClose={onClose}>
      <p className="modal-text">Estes dispositivos do projeto não estão conectados agora. Escolha um substituto ou mantenha o original: se ele for conectado depois, volta a funcionar sozinho.</p>
      <ul className="missing-list">
        {items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.what}</strong>
              <span>{displayName(item.ref.label)}</span>
            </div>
            <select className="option-select" value={choices[item.id]} onChange={(e) => setChoices({ ...choices, [item.id]: e.target.value })} aria-label={`Substituto para ${item.what}`}>
              <option value="">Manter e aguardar reconexão</option>
              {realDevices(devices, item.kind).map((d) => <option key={d.deviceId} value={d.deviceId}>{displayName(d.label)}</option>)}
            </select>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Manter todos</button>
        <button type="button" className="btn btn-primary" onClick={apply}>Aplicar</button>
      </div>
    </Modal>
  );
}

const ACCESS_TEXT = { granted: 'Liberado', denied: 'Negado', restricted: 'Bloqueado', 'not-determined': 'Não pedido', unknown: '?' };

/** Situação das permissões do macOS, com atalho para Ajustes quando algo foi negado. */
export function PermissionBar({ access, onRequest, onOpenSettings }: {
  access: MediaAccess | null;
  onRequest: (kind: 'camera' | 'microphone') => void;
  onOpenSettings: (kind: 'camera' | 'microphone' | 'screen') => void;
}) {
  if (!access) return null;
  const items = [
    { kind: 'camera' as const, label: 'Câmera', status: access.camera },
    { kind: 'microphone' as const, label: 'Microfone', status: access.microphone },
    { kind: 'screen' as const, label: 'Captura de tela', status: access.screen },
  ];
  return (
    <div className="permissions">
      {items.map((item) => (
        <span key={item.kind} className={`permission permission-${item.status}`} title={`Permissão do macOS: ${ACCESS_TEXT[item.status]}`}>
          <i />{item.label}
          {item.status === 'not-determined' && item.kind !== 'screen' && <button type="button" className="link-btn" onClick={() => onRequest(item.kind as 'camera' | 'microphone')}>Pedir</button>}
          {(item.status === 'denied' || item.status === 'restricted') && <button type="button" className="link-btn" onClick={() => onOpenSettings(item.kind)}>Abrir Ajustes</button>}
        </span>
      ))}
    </div>
  );
}
