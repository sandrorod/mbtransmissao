import { useCallback, useEffect, useRef, useState } from 'react';
import { diffDevices, type DeviceChanges, type SystemDevice } from './identify';
import { pool } from './pool';

const KINDS = new Set(['videoinput', 'audioinput', 'audiooutput']);

/** Nenhuma etapa da busca pode prender a tela: depois do prazo segue sem ela (e registra o motivo). */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: sem resposta em ${ms / 1000} s`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

const log = (text: string) => {
  try { window.studio?.liveLog?.(`aparelhos: ${text}`); } catch { /* sem registro */ }
};

async function readDevices(): Promise<SystemDevice[]> {
  const list = await withTimeout(navigator.mediaDevices.enumerateDevices(), 8000, 'lista de aparelhos');
  return list.filter((d) => KINDS.has(d.kind)).map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label, kind: d.kind as SystemDevice['kind'] }));
}

/**
 * Sem uma captura autorizada o Chromium esconde os nomes dos aparelhos.
 * Abre câmera e microfone por um instante (cada um separado, para um não impedir o outro) e fecha.
 */
async function unlockLabels(): Promise<void> {
  for (const constraints of [{ video: true }, { audio: true }] as MediaStreamConstraints[]) {
    // Com prazo: câmera ocupada por outro app ou pedido de permissão sem resposta prendiam a tela em
    // "Procurando câmeras…" para sempre. Se a captura chegar depois do prazo, é fechada na hora.
    const request = navigator.mediaDevices.getUserMedia(constraints);
    try {
      const stream = await withTimeout(request, 6000, constraints.video ? 'câmera' : 'microfone');
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      // Sem câmera (ou sem permissão) a lista continua; o painel de permissões avisa.
      log(String(e instanceof Error ? e.message : e));
      void request.then((s) => s.getTracks().forEach((t) => t.stop()), () => undefined);
    }
  }
}

/**
 * Lista viva dos dispositivos do sistema. Atualiza no evento do macOS (devicechange) e, por garantia,
 * a cada poucos segundos, porque algumas placas de captura demoram a avisar.
 */
export function useSystemDevices(onChange: (changes: DeviceChanges, devices: SystemDevice[]) => void, extra: SystemDevice[] = []) {
  const [devices, setDevices] = useState<SystemDevice[]>([]);
  const [ready, setReady] = useState(false);
  const previous = useRef<SystemDevice[] | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const busy = useRef(false);
  const again = useRef(false);
  // Celulares e páginas entram na mesma lista: ligar/desligar funciona igual para todos.
  const extraRef = useRef(extra);
  extraRef.current = extra;
  const extraKey = extra.map((d) => `${d.kind}|${d.deviceId}|${d.label}`).join(',');

  const refresh = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      let system = await readDevices();
      if (system.some((d) => d.kind !== 'audiooutput' && !d.label)) {
        await unlockLabels();
        system = await readDevices();
      }
      const list = [...system, ...extraRef.current];
      const before = previous.current;
      // Mesma lista da última consulta (o caso comum, a cada 4 s): mantém o mesmo array. Trocar sempre
      // redesenhava o App inteiro a cada 4 s e, no Mac lento, o Programa engasgava junto.
      const key = (l: SystemDevice[]) => l.map((d) => `${d.kind}|${d.deviceId}|${d.groupId}|${d.label}`).join(',');
      if (before && key(before) === key(list)) {
        pool.sync(before);
        return;
      }
      previous.current = list;
      setDevices(list);
      pool.sync(list);
      if (before) {
        const changes = diffDevices(before, list);
        if (changes.added.length || changes.removed.length) latest.current(changes, list);
      }
      setReady(true);
    } catch (e) {
      // Um erro na busca não pode deixar a tela parada: segue com o que tiver e tenta de novo em 4 s.
      log(`erro na busca: ${e instanceof Error ? e.message : String(e)}`);
      setReady(true);
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [extraKey, refresh]);

  useEffect(() => {
    void refresh();
    const onDeviceChange = () => void refresh();
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      clearInterval(timer);
    };
  }, [refresh]);

  return { devices, ready, refresh };
}
