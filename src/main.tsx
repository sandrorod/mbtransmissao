import { StrictMode, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installTooltips } from './components/common';
import { LoginScreen } from './components/Account';
import type { AccountView } from './types/studio';
import { runE2E, runSelfTest } from './selftest';
import './styles/global.css';

// Autoteste com os dispositivos reais (npm run selftest): roda sem interface e grava um relatório.
void window.studio.selfTestMode().then((mode) => {
  if (mode === 'pagina') {
    void import('./diagPage').then((m) => m.runPageDiag());
    return;
  }
  if (mode === 'chroma') {
    void import('./diagChroma').then((m) => m.runChromaDiag());
    return;
  }
  if (mode === 'gravador') {
    void import('./diagRecorder').then((m) => m.runRecorderDiag());
    return;
  }
  if (mode === 'e2e') {
    void runE2E();
    return;
  }
  if (mode) {
    void runSelfTest();
    return;
  }
  installTooltips();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
});

/** Sem conta logada, só a tela de entrada; logado, o estúdio com tudo o que a pessoa configurou. */
function Root() {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    void window.studio.accountState().then(setAccount, (e: unknown) => setFailed(String(e)));
  }, []);
  if (failed) return <div className="loading">{failed}</div>;
  if (!account) return <div className="loading"><LoaderCircle size={22} className="spin" /> Entrando na sua conta…</div>;
  if (!account.local && !account.user) return <LoginScreen account={account} onDone={setAccount} />;
  return (
    <App
      account={account}
      onLogout={() => {
        void window.studio.accountLogout().then(
          // Recarrega a tela: nada do usuário anterior fica aberto (câmeras, páginas, mixer).
          () => window.location.reload(),
          (e: unknown) => window.alert(String(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
        );
      }}
    />
  );
}
