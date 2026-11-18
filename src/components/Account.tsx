import { useEffect, useState, type FormEvent } from 'react';
import { Cloud, CloudOff, LoaderCircle, LogOut, Radio, RefreshCw } from 'lucide-react';
import type { AccountView } from '../types/studio';

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Tela de entrada: e-mail e senha. Ao entrar, o app baixa tudo o que a pessoa deixou configurado. */
export function LoginScreen({ account, onDone }: { account: AccountView; onDone: (view: AccountView) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await window.studio.accountLogin(email, password, create));
    } catch (err) {
      setError(clean(err));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="login-brand"><Radio size={26} /><span>Estúdio ao Vivo</span></div>
        <p className="login-lead">{create ? 'Crie sua conta. Suas cenas, widgets, layout e destinos ficam salvos nela.' : 'Entre para carregar suas cenas, widgets, layout, destinos e conta do YouTube.'}</p>
        {!account.configured && <p className="login-error" role="alert">O servidor das contas ainda não foi configurado neste aplicativo.</p>}
        <label className="option-field">
          <span className="option-label">E-mail</span>
          <input className="field" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} required />
        </label>
        <label className="option-field">
          <span className="option-label">Senha</span>
          <input className="field" type="password" autoComplete={create ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} required minLength={create ? 6 : undefined} />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary login-submit" disabled={busy || !account.configured}>
          {busy ? <><LoaderCircle size={15} className="spin" /> {create ? 'Criando…' : 'Entrando e baixando suas configurações…'}</> : create ? 'Criar conta' : 'Entrar'}
        </button>
        <button type="button" className="login-switch" disabled={busy} onClick={() => { setCreate(!create); setError(null); }}>
          {create ? 'Já tenho conta: entrar' : 'Não tem conta? Criar conta'}
        </button>
      </form>
    </div>
  );
}

const SYNC_TEXT: Record<AccountView['sync']['state'], string> = {
  sincronizado: 'Tudo salvo na sua conta',
  pendente: 'Alterações a salvar na conta…',
  enviando: 'Salvando na conta…',
  'sem-internet': 'Sem internet: salvo neste Mac; envia quando voltar',
  erro: 'Não salvou na conta',
};

/** Chip da conta no cabeçalho: quem está logado, situação da nuvem e Sair. */
export function AccountChip({ account, live, onLogout }: { account: AccountView; live: boolean; onLogout: () => void }) {
  const [sync, setSync] = useState(account.sync);
  useEffect(() => window.studio.onAccountSync(setSync), []);
  if (account.local || !account.user) return null;
  const bad = sync.state === 'erro' || sync.state === 'sem-internet';
  const tip = `${account.user.email}\n${SYNC_TEXT[sync.state]}${sync.message ? `\n${sync.message}` : ''}`;
  return (
    <span className={`account-chip ${bad ? 'account-bad' : ''}`} data-tip={tip} data-tip-wide="">
      <button type="button" className="icon-btn" aria-label="Salvar na conta agora" onClick={() => void window.studio.accountSyncNow().then((v) => setSync(v.sync))}>
        {sync.state === 'enviando' ? <RefreshCw size={14} className="spin" /> : bad ? <CloudOff size={14} /> : <Cloud size={14} />}
      </button>
      <span className="account-email">{account.user.email}</span>
      <button type="button" className="icon-btn" aria-label="Sair da conta" data-tip={live ? 'Pare a transmissão para sair' : 'Sair da conta'} disabled={live} onClick={onLogout}><LogOut size={14} /></button>
    </span>
  );
}
