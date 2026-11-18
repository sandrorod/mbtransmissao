import { Eye, Play, Square, X } from 'lucide-react';

/** Ações em grupo para os itens marcados (dispositivos de vídeo e mídias). */
export interface GroupActions {
  count: number;
  onPreview: () => void;
  onProgram: () => void;
  onStop: () => void;
  onClear: () => void;
}

/** "Selecionar todos" de uma lista: marcado, meio marcado ou vazio. */
export function SelectAll({ ids, selected, onSelect, label }: { ids: string[]; selected: Set<string>; onSelect: (ids: string[], on: boolean) => void; label: string }) {
  const marked = ids.filter((id) => selected.has(id)).length;
  return (
    <label className="select-all" data-tip={label}>
      <input
        type="checkbox"
        aria-label={label}
        disabled={ids.length === 0}
        checked={ids.length > 0 && marked === ids.length}
        ref={(el) => { if (el) el.indeterminate = marked > 0 && marked < ids.length; }}
        onChange={(e) => onSelect(ids, e.target.checked)}
      />
      Todos
    </label>
  );
}

/** Barra que aparece quando há itens marcados. */
export function SelectionBar({ actions }: { actions: GroupActions }) {
  if (actions.count === 0) return null;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Itens selecionados">
      <strong>{actions.count} {actions.count === 1 ? 'selecionado' : 'selecionados'}</strong>
      <button type="button" className="btn btn-small" onClick={actions.onPreview} data-tip="Põe todos os selecionados na Prévia"><Eye size={13} /> Prévia</button>
      <button type="button" className="btn btn-small btn-primary" onClick={actions.onProgram} data-tip="Coloca todos os selecionados no Programa"><Play size={13} /> Programa</button>
      <button type="button" className="btn btn-small tile-btn-stop" onClick={actions.onStop} data-tip="Tira do Programa os selecionados que estão no ar"><Square size={12} /> Tirar do ar</button>
      <button type="button" className="icon-btn" aria-label="Limpar seleção" data-tip="Limpar seleção" onClick={actions.onClear}><X size={14} /></button>
    </div>
  );
}
