import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';

export interface MenuEntry {
  label: string;
  icon?: ReactNode;
  /** Atalho mostrado à direita (só informativo). */
  hint?: string;
  /** Marcado (aparece um ✓ alinhado à direita). */
  checked?: boolean;
  disabled?: boolean;
  /** Mantém o menu aberto depois do clique (ex.: ligar/desligar várias áreas). */
  keepOpen?: boolean;
  /** Abre uma lista ao lado (passando o mouse ou clicando); aí run não é usado. */
  submenu?: MenuItem[];
  run?: () => void;
}

export type MenuItem = MenuEntry | 'separator';

/** Barra de menus do app: Projeto, Configurações e Exibição. */
export function AppMenu({ menus }: { menus: { label: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  /** Item com submenu aberto (rótulo), dentro do menu aberto. */
  const [sub, setSub] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setSub(null), [open]);

  useEffect(() => {
    if (open === null) return;
    const down = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div className="app-menu" ref={root} role="menubar">
      {menus.map((menu, i) => (
        <div key={menu.label} className="app-menu-group">
          <button
            type="button"
            className={`app-menu-button ${open === i ? 'app-menu-button-open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => { if (open !== null && open !== i) setOpen(i); }}
          >
            {menu.label} <ChevronDown size={12} />
          </button>
          {open === i && (
            <div className="app-menu-list" role="menu">
              {menu.items.map((item, j) => item === 'separator' ? <div key={`s${j}`} className="app-menu-separator" role="separator" /> : (
                <div key={item.label} className="app-menu-entry" onPointerEnter={() => setSub(item.submenu ? item.label : null)}>
                  <MenuButton item={item} open={sub === item.label} onRun={() => {
                    if (item.submenu) {
                      setSub(item.label);
                      return;
                    }
                    if (!item.keepOpen) setOpen(null);
                    item.run?.();
                  }} />
                  {item.submenu && sub === item.label && (
                    <div className="app-menu-list app-menu-sublist" role="menu" aria-label={item.label}>
                      {item.submenu.map((child, k) => child === 'separator' ? <div key={`s${k}`} className="app-menu-separator" role="separator" /> : (
                        <MenuButton key={child.label} item={child} open={false} onRun={() => {
                          if (!child.keepOpen) setOpen(null);
                          child.run?.();
                        }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MenuButton({ item, open, onRun }: { item: MenuEntry; open: boolean; onRun: () => void }) {
  return (
    <button
      type="button"
      role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={item.checked}
      aria-haspopup={item.submenu ? 'menu' : undefined}
      aria-expanded={item.submenu ? open : undefined}
      className={`app-menu-item ${open ? 'app-menu-item-open' : ''}`}
      disabled={item.disabled}
      onClick={onRun}
    >
      <span className="app-menu-icon">{item.icon}</span>
      <span className="app-menu-label">{item.label}</span>
      {item.hint && <span className="app-menu-hint">{item.hint}</span>}
      {item.checked !== undefined && <span className="app-menu-check">{item.checked ? <Check size={14} /> : null}</span>}
      {item.submenu && <span className="app-menu-arrow"><ChevronRight size={14} /></span>}
    </button>
  );
}
