import { useEffect, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { CloudUpload, Copy, Download, Globe, KeyRound, Upload, LogOut, Pencil, Plus, Radio, RefreshCw, Smartphone, Trash2, MonitorPlay } from 'lucide-react';
import { phones } from '../phone/phones';
import { OUTPUT_PRESETS, PLATFORMS, type Destination, type DestinationInput, type OutputSettings, type PhoneLink, type Platform, type PhoneQuality, type TurnServer, type DriveState, type ReplayGalleryLink, type Project, type SessionSummary, type YoutubeBroadcast, type YoutubeState, youtubeDestinationId } from '../types/studio';
import { turnServer, validPageUrl } from '../utils/validate';
import { Modal } from './common';

export function ConfirmDialog({ title, message, confirm, onConfirm, onClose }: { title: string; message: string; confirm: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-text">{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-danger" onClick={() => { onConfirm(); onClose(); }} autoFocus>{confirm}</button>
      </div>
    </Modal>
  );
}

/**
 * Encerrar a transmissão: pergunta antes e deixa escolher entre só parar o envio (a live continua aberta
 * no YouTube para voltar a transmitir nela) ou finalizar a live de vez.
 */
export function StopLiveDialog({ youtube, title, onStop, onClose }: { youtube: boolean; title: string | null; onStop: (endBroadcast: boolean) => void; onClose: () => void }) {
  return (
    <Modal title="Encerrar a transmissão?" onClose={onClose}>
      <p className="modal-text">O envio vai parar em todas as plataformas.</p>
      {youtube && (
        <p className="modal-text">
          No YouTube{title ? <> (live <b>{title}</b>)</> : null}: <b>manter a live aberta</b> deixa voltar a transmitir nela depois (ela continua
          na lista ao escolher a live). <b>Finalizar</b> encerra de vez; ela não recebe mais vídeo.
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus>Continuar transmitindo</button>
        {youtube ? (
          <>
            <button type="button" className="btn" onClick={() => onStop(false)}>Parar e manter a live</button>
            <button type="button" className="btn btn-danger" onClick={() => onStop(true)}>Parar e finalizar a live</button>
          </>
        ) : (
          <button type="button" className="btn btn-danger" onClick={() => onStop(false)}>Encerrar</button>
        )}
      </div>
    </Modal>
  );
}

/** Link e QR Code para celulares entrarem como câmera (mesma rede Wi‑Fi, ou endereço público quando houver). */
export function PhoneDialog({ publicAddress, onPublicAddress, turn, onTurn, quality, onQuality, onClose }: { publicAddress: string; onPublicAddress: (address: string) => void; turn: TurnServer | null; onTurn: (turn: TurnServer | null) => void; quality: PhoneQuality; onQuality: (quality: PhoneQuality) => void; onClose: () => void }) {
  const [link, setLink] = useState<PhoneLink | null>(null);
  const [chosen, setChosen] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [address, setAddress] = useState(publicAddress);
  const [turnDraft, setTurnDraft] = useState<TurnServer>(turn ?? { urls: '', username: '', credential: '' });
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [relayMsg, setRelayMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => window.studio.onPhoneRemote(setLink), []);
  useSyncExternalStore(phones.subscribe, phones.getVersion);
  const connected = phones.list();

  useEffect(() => { void window.studio.phoneLink().then(setLink); }, [publicAddress, turn]);
  const remote = link?.remote ?? { state: 'desligado' as const, url: null, message: null };
  const remoteOn = remote.state === 'ligado' || remote.state === 'preparando';
  const mode = link?.remoteMode ?? 'cloudflare';
  const toggleRemote = (on: boolean, next = mode) => {
    setRemoteError(null);
    window.studio.setPhoneRemote(on, next).then(setLink, (e: unknown) => setRemoteError(ipcError(e)));
  };
  const saveRelay = () => {
    setRelayMsg(null);
    window.studio.setPhoneRelay(address, secret.trim() ? secret.trim() : null).then((l) => {
      setLink(l);
      setSecret('');
      onPublicAddress(address.replace(/\/+$/, ''));
      setRelayMsg({ ok: true, text: l.relayReady ? 'Servidor salvo.' : 'Endereço salvo. Falta a chave.' });
    }, (e: unknown) => setRelayMsg({ ok: false, text: ipcError(e) }));
  };
  const turnValid = turnServer(turnDraft);
  const turnEmpty = !turnDraft.urls.trim() && !turnDraft.username.trim() && !turnDraft.credential.trim();
  const url = link?.publicUrl ?? link?.urls[chosen] ?? null;
  useEffect(() => {
    if (!url) return setQr(null);
    void QRCode.toDataURL(url, { margin: 1, width: 520, color: { dark: '#0b0c0e', light: '#ffffff' } }).then(setQr);
  }, [url]);

  const addressOk = address === '' || validPageUrl(address);
  return (
    <Modal title="Conectar celular" onClose={onClose} wide>
      <div className="phone-layout">
        <div className="phone-qr">
          {remote.state === 'preparando' ? <div className="qr-empty">{remote.message ?? 'Abrindo o endereço público…'}</div>
            : qr ? <img src={qr} alt="QR Code do link para o celular" /> : <div className="qr-empty">{link?.error ?? 'Preparando o link…'}</div>}
        </div>
        <div className="phone-info">
          <div className="phone-remote">
            <Globe size={16} />
            <div>
              <strong>Celular em outra rede (4G ou outro Wi‑Fi)</strong>
              <span>{remote.state === 'ligado' ? 'Endereço público ligado: o link abaixo funciona de qualquer lugar.' : remote.state === 'preparando' ? (remote.message ?? 'Abrindo…') : 'Desligado: só celulares no mesmo Wi‑Fi.'}</span>
            </div>
            <input type="checkbox" className="switch" checked={remoteOn} aria-label="Celular em outra rede" onChange={(e) => toggleRemote(e.target.checked)} />
          </div>
          <label className="option-field">
            <span className="option-label">Link para outra rede por</span>
            <select className="option-select" value={mode} onChange={(e) => {
              const next = e.target.value as 'cloudflare' | 'servidor';
              setRemoteError(null);
              // Trocar o modo com o link ligado já religa pelo outro caminho.
              window.studio.setPhoneRemote(remoteOn, next).then(setLink, (err: unknown) => setRemoteError(ipcError(err)));
            }}>
              <option value="cloudflare">Túnel rápido da Cloudflare (link muda a cada vez)</option>
              <option value="servidor" disabled={!link?.relayReady}>Meu servidor{publicAddress ? ` · ${publicAddress.replace(/^https?:\/\//, '')}` : ''}{link?.relayReady ? ' (link fixo)' : ' — configure abaixo'}</option>
            </select>
          </label>
          {(remote.state === 'erro' || remoteError) && <p className="device-error">{remoteError ?? remote.message}</p>}
          {remote.state === 'ligado' && !turn && <p className="hint">No 4G, algumas operadoras bloqueiam o vídeo direto. Se o celular conectar mas ficar “Sem vídeo”, configure um servidor TURN em <b>Retransmissão do vídeo</b>, abaixo.</p>}
          <p className="modal-text">
            {link?.publicUrl
              ? 'Aponte a câmera do celular para o QR Code ou envie o link. Todo celular que entrar aparece em Dispositivos conectados.'
              : 'O celular precisa estar no mesmo Wi‑Fi deste computador. Aponte a câmera para o QR Code (ou envie o link) e toque em “Compartilhar câmera”. Todo celular que entrar aparece em Dispositivos conectados.'}
          </p>
          {link && !link.publicUrl && link.urls.length > 1 && (
            <label className="option-field">
              <span className="option-label">Rede deste computador</span>
              <select className="option-select" value={chosen} onChange={(e) => setChosen(Number(e.target.value))}>
                {link.urls.map((u, i) => <option key={u} value={i}>{new URL(u).hostname}</option>)}
              </select>
            </label>
          )}
          {link && !link.publicUrl && link.urls.length === 0 && <p className="device-error">Este computador não está conectado a nenhuma rede Wi‑Fi ou cabo.</p>}
          {url && (
            <div className="link-row">
              <input className="field" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Link para o celular" />
              <button type="button" className="btn btn-small" onClick={() => { void window.studio.copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Copy size={13} /> {copied ? 'Copiado' : 'Copiar'}</button>
            </div>
          )}
          {remote.state === 'ligado' && mode === 'cloudflare' && <p className="hint">O link muda cada vez que o endereço público é ligado. Ele só funciona com este código; desligue quando terminar.</p>}
          {remote.state === 'ligado' && mode === 'servidor' && <p className="hint">Link fixo do seu domínio: pode deixar o QR Code impresso. Ele só funciona com este código (use “Gerar novo link” para trocar).</p>}
          {!link?.publicUrl && (
            <p className="hint">Na primeira vez, o celular avisa que a conexão “não é particular” (o certificado é deste computador): toque em <b>Mostrar detalhes / Avançado</b> e depois em <b>visitar o site / Continuar</b>. Se o Mac perguntar sobre conexões de entrada, clique em <b>Permitir</b>.</p>
          )}
          <button type="button" className="link-btn" onClick={() => void window.studio.newPhoneLink().then(setLink)} title="O link antigo deixa de aceitar celulares novos; os conectados continuam"><RefreshCw size={12} /> Gerar novo link</button>

          <h3 className="group-title">Celulares conectados <span>{connected.length}</span></h3>
          {connected.length === 0 ? <p className="empty-text">Nenhum ainda.</p> : (
            <ul className="phone-list">
              {connected.map((p) => (
                <li key={p.id}>
                  <Smartphone size={14} />
                  <span>{p.name}</span>
                  <span className={`status-tag status-${p.state === 'ao-vivo' ? 'ativo' : p.state === 'conectando' ? 'abrindo' : 'falhou'}`}><i />{p.state === 'ao-vivo' ? 'Enviando vídeo' : p.state === 'conectando' ? 'Conectando' : 'Sem vídeo'}</span>
                  <button type="button" className="icon-btn icon-btn-remove" aria-label={`Remover ${p.name}`} title="Desconectar e remover" onClick={() => phones.remove(p.id)}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}

          <details className="defaults">
            <summary>Retransmissão do vídeo (TURN) {turn ? '· configurada' : ''}</summary>
            <p className="hint">Para o vídeo passar por redes 4G que bloqueiam conexão direta. Crie uma conta grátis (ex.: Metered.ca ou Cloudflare Calls) e copie os dados do servidor TURN.</p>
            <label className="option-field">
              <span className="option-label">Endereços (separe por vírgula)</span>
              <input className={`field ${turnEmpty || turnValid ? '' : 'select-missing'}`} placeholder="turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp" value={turnDraft.urls} onChange={(e) => setTurnDraft({ ...turnDraft, urls: e.target.value })} aria-label="Endereços TURN" spellCheck={false} />
            </label>
            <div className="link-row">
              <input className="field" placeholder="Usuário" value={turnDraft.username} onChange={(e) => setTurnDraft({ ...turnDraft, username: e.target.value })} aria-label="Usuário do TURN" spellCheck={false} />
              <input className="field" type="password" placeholder="Senha" value={turnDraft.credential} onChange={(e) => setTurnDraft({ ...turnDraft, credential: e.target.value })} aria-label="Senha do TURN" />
            </div>
            <div className="link-row">
              <button type="button" className="btn btn-small" disabled={!turnValid} onClick={() => onTurn(turnValid)}>Salvar</button>
              {turn && <button type="button" className="btn btn-small" onClick={() => { setTurnDraft({ urls: '', username: '', credential: '' }); onTurn(null); }}>Remover</button>}
              {!turnEmpty && !turnValid && <span className="device-error">Use endereços turn: ou turns: e preencha usuário e senha.</span>}
            </div>
            <p className="hint">Vale para os celulares que conectarem depois de salvar.</p>
          </details>

          <details className="defaults">
            <summary>Qualidade dos celulares · {quality.mbps} Mbps · {quality.priority === 'nitidez' ? 'nitidez' : quality.priority === 'fluidez' ? 'fluidez' : 'equilíbrio'}</summary>
            <label className="option-field">
              <span className="option-label">Taxa máxima de cada celular <output>{quality.mbps} Mbps</output></span>
              <input type="range" min={2} max={16} step={1} value={quality.mbps} onChange={(e) => onQuality({ ...quality, mbps: Number(e.target.value) })} aria-label="Taxa máxima de cada celular" />
            </label>
            <label className="option-field">
              <span className="option-label">Quando o celular esquentar ou o Wi‑Fi apertar</span>
              <select className="option-select" value={quality.priority} onChange={(e) => onQuality({ ...quality, priority: e.target.value as PhoneQuality['priority'] })}>
                <option value="nitidez">Manter a nitidez (pode perder quadros)</option>
                <option value="equilibrio">Equilíbrio (recomendado)</option>
                <option value="fluidez">Manter o movimento (pode perder nitidez)</option>
              </select>
            </label>
            <p className="hint">Vale na hora para os celulares conectados. Em “Informações” (i) de cada celular aparece o que ele está mandando e se reduziu por calor/processador ou pela rede. Some celulares × taxa: com 3 celulares a 8 Mbps o Wi‑Fi precisa de ~24 Mbps livres (prefira 5 GHz e o Mac no cabo).</p>
          </details>

          <details className="defaults">
            <summary>Meu servidor (domínio próprio) {link?.relayReady ? '· configurado' : ''}</summary>
            <p className="hint">Link fixo no seu domínio, com certificado de verdade (o celular não mostra aviso). Instale o serviço <b>camera-relay</b> no Easypanel (instruções em camera-relay/README.md) e use aqui o mesmo endereço e a mesma chave (RELAY_SECRET).</p>
            <label className="option-field">
              <span className="option-label">Endereço</span>
              <input className={`field ${addressOk ? '' : 'select-missing'}`} placeholder="https://camera.seudominio.com.br" value={address} onChange={(e) => setAddress(e.target.value.trim())} aria-label="Endereço do servidor" spellCheck={false} />
            </label>
            <label className="option-field">
              <span className="option-label">Chave (RELAY_SECRET){link?.relayReady ? ' · guardada, deixe vazio para manter' : ''}</span>
              <input className="field" type="password" placeholder={link?.relayReady ? '••••••••••••' : 'mínimo 16 caracteres'} value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Chave do servidor" autoComplete="off" />
            </label>
            <div className="link-row">
              <button type="button" className="btn btn-small" disabled={!addressOk || (address === publicAddress && !secret.trim())} onClick={saveRelay}>Salvar</button>
              {relayMsg && <span className={relayMsg.ok ? 'hint' : 'device-error'}>{relayMsg.text}</span>}
            </div>
          </details>
        </div>
      </div>
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Concluir</button></div>
    </Modal>
  );
}

const ipcError = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

const STATUS_YT: Record<string, string> = { created: 'Programada', ready: 'Pronta', testing: 'Em teste', live: 'No ar', liveStarting: 'Começando', testStarting: 'Começando' };
const PRIVACY_YT = { public: 'Pública', unlisted: 'Não listada', private: 'Privada' };

const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/**
 * Conta do YouTube: puxa as lives programadas do canal e cria novas. Ao escolher uma, o Estúdio liga a
 * live ao stream dele e passa a transmitir para ela, sem a chave aparecer na tela.
 */
function YoutubePanel({ account, number, destinations, onDestinations, onRemove }: { account: YoutubeState; number: number; destinations: Destination[]; onDestinations: (list: Destination[]) => void; onRemove: () => void }) {
  const id = account.id;
  const [state, setState] = useState<YoutubeState | null>(account);
  const [clientId, setClientId] = useState(account.clientId);
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lives, setLives] = useState<YoutubeBroadcast[] | null>(null);
  const [form, setForm] = useState<{ title: string; description: string; start: string; privacy: YoutubeBroadcast['privacy'] } | null>(null);
  const destination = destinations.find((d) => d.id === youtubeDestinationId(id)) ?? null;
  const managed = destination?.enabled ? destination : undefined;
  const liveName = (title: string) => `YouTube${state?.channel ? ` (${state.channel.title})` : ''} · ${title}`;

  const run = async <T,>(label: string, task: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    setError(null);
    try {
      return await task();
    } catch (e) {
      setError(ipcError(e));
      return null;
    } finally {
      setBusy(null);
    }
  };
  const loadLives = () => void run('Buscando lives do canal…', async () => setLives(await window.studio.youtubeBroadcasts(id)));

  useEffect(() => {
    if (account.connected) loadLives();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const use = (broadcastId: string) => void run('Ligando a live ao Estúdio…', async () => onDestinations(await window.studio.youtubeUse(id, broadcastId)));

  if (!state) return null;
  const credentials = !state.configured || editing;
  return (
    <div className="yt yt-card">
      <div className="yt-card-head">
        <strong><MonitorPlay size={14} /> {state.channel?.title ?? `Canal ${number}`}</strong>
        {destination && (
          <label className="yt-send" title="Liga ou desliga a transmissão para este canal">
            <input type="checkbox" className="switch" checked={destination.enabled} onChange={async (e) => onDestinations(await window.studio.saveDestination({ id: destination.id, platform: destination.platform, name: destination.name, server: destination.server, key: '', enabled: e.target.checked }))} />
            {destination.enabled ? 'Transmitir neste canal' : 'Não transmitir aqui'}
          </label>
        )}
        <button type="button" className="icon-btn icon-btn-remove" title="Tirar este canal do Estúdio" aria-label={`Tirar ${state.channel?.title ?? `Canal ${number}`} do Estúdio`} onClick={onRemove}><Trash2 size={14} /></button>
      </div>
      {credentials ? (
        <form className="settings-form" onSubmit={(e) => {
          e.preventDefault();
          void run('Salvando…', async () => {
            const s = await window.studio.youtubeSetClient(id, clientId, secret);
            setState(s);
            setSecret('');
            setEditing(false);
          });
        }}>
          <p className="hint">Para o Estúdio criar e puxar as lives do seu canal, o YouTube exige um acesso próprio (é de graça, uma vez só):</p>
          <ol className="steps">
            <li>Em <b>console.cloud.google.com</b>, crie um projeto e ative a <b>YouTube Data API v3</b>.</li>
            <li>Em <b>Tela de consentimento OAuth</b>: tipo Externo, e adicione o seu e‑mail em <b>Usuários de teste</b>.</li>
            <li>Em <b>Credenciais → Criar credenciais → ID do cliente OAuth</b>, escolha <b>App para computador</b>.</li>
            <li>Cole aqui o <b>ID do cliente</b> e a <b>Chave secreta do cliente</b>.</li>
          </ol>
          <label className="option-field"><span className="option-label">ID do cliente</span><input className="field" value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="123456-abc.apps.googleusercontent.com" /></label>
          <label className="option-field"><span className="option-label">Chave secreta do cliente</span><input className="field" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value.trim())} placeholder="GOCSPX-…" /></label>
          <div className="modal-actions">
            {state.configured && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancelar</button>}
            <button type="submit" className="btn btn-primary" disabled={!clientId || !secret || Boolean(busy)}>Salvar</button>
          </div>
        </form>
      ) : !state.connected ? (
        <div className="settings-form">
          <p className="hint">Abre o Google no navegador para você autorizar o Estúdio a criar e ver as lives do canal. {number > 1 && 'Entre com a conta do outro canal (se ela tiver vários canais, o Google pergunta qual).'}</p>
          <div className="row-actions">
            <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void run('Aguardando a autorização no navegador…', async () => {
              const s = await window.studio.youtubeConnect(id);
              setState(s);
              loadLives();
            })}><MonitorPlay size={14} /> Entrar com a conta do canal</button>
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>Trocar credenciais</button>
          </div>
        </div>
      ) : (
        <div className="settings-form">
          <div className="yt-channel">
            {state.channel?.thumbnail && <img src={state.channel.thumbnail} alt="" />}
            <strong>{state.channel?.title ?? 'Canal conectado'}</strong>
            <button type="button" className="icon-btn" title="Atualizar lista" aria-label="Atualizar lista de lives" onClick={loadLives}><RefreshCw size={14} /></button>
            <button type="button" className="icon-btn icon-btn-remove" title="Desconectar conta" aria-label="Desconectar conta" onClick={() => void run('Desconectando…', async () => { setState(await window.studio.youtubeDisconnect(id)); setLives(null); })}><LogOut size={14} /></button>
          </div>
          {managed && <p className="yt-using">Transmitindo para: <b>{managed.name.replace(/^YouTube( \([^)]*\))? · /, '')}</b></p>}
          {lives && lives.length === 0 && !form && <p className="empty-text">Nenhuma live programada no canal.</p>}
          {lives && lives.length > 0 && (
            <ul className="yt-list">
              {lives.map((b) => {
                const active = managed?.name === liveName(b.title) || managed?.name === `YouTube · ${b.title}`;
                return (
                  <li key={b.id} className={active ? 'yt-active' : ''}>
                    {b.thumbnail ? <img src={b.thumbnail} alt="" /> : <span className="yt-thumb" />}
                    <div className="yt-info">
                      <strong title={b.title}>{b.title}</strong>
                      <span>{b.scheduledStart ? new Date(b.scheduledStart).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Sem data'} · {STATUS_YT[b.status] ?? b.status} · {PRIVACY_YT[b.privacy] ?? b.privacy}</span>
                    </div>
                    <button type="button" className={`btn btn-small ${active ? 'btn-on' : ''}`} disabled={Boolean(busy) || active} onClick={() => use(b.id)}>{active ? 'Em uso' : 'Usar esta'}</button>
                  </li>
                );
              })}
            </ul>
          )}
          {form ? (
            <form className="settings-form destination-form" onSubmit={(e) => {
              e.preventDefault();
              void run('Criando a live no YouTube…', async () => {
                const created = await window.studio.youtubeCreate(id, { title: form.title, description: form.description, scheduledStart: new Date(form.start).toISOString(), privacy: form.privacy });
                onDestinations(await window.studio.youtubeUse(id, created.id));
                setLives(await window.studio.youtubeBroadcasts(id));
                setForm(null);
              });
            }}>
              <label className="option-field"><span className="option-label">Título</span><input className="field" value={form.title} maxLength={100} autoFocus onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Ex.: Final do Campeonato · ao vivo" /></label>
              <label className="option-field"><span className="option-label">Descrição</span><textarea className="field textarea" value={form.description} maxLength={5000} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              <div className="size-row">
                <label className="option-field"><span className="option-label">Início</span><input className="field" type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
                <label className="option-field"><span className="option-label">Visibilidade</span>
                  <select className="option-select" value={form.privacy} onChange={(e) => setForm({ ...form, privacy: e.target.value as YoutubeBroadcast['privacy'] })}>
                    <option value="public">Pública</option><option value="unlisted">Não listada</option><option value="private">Privada</option>
                  </select>
                </label>
              </div>
              <p className="hint">A live começa sozinha no YouTube quando você clicar em Transmitir, e termina quando encerrar.</p>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={!form.title.trim() || Boolean(busy)}>Criar e usar</button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn btn-small" onClick={() => setForm({ title: '', description: '', start: localInput(new Date(Date.now() + 5 * 60000)), privacy: 'unlisted' })}><Plus size={13} /> Criar transmissão no YouTube</button>
          )}
        </div>
      )}
      {busy && <p className="hint">{busy}</p>}
      {busy?.startsWith('Aguardando a autorização') && (
        <div className="yt-wait">
          <p className="hint">Se o Google mostrar <b>“Erro 403: access_denied”</b> ou “não concluiu o processo de verificação”, o e‑mail usado no login não está em <b>Usuários de teste</b>. No Google Cloud abra <b>Google Auth Platform → Público-alvo (Audience) → Usuários de teste → Adicionar usuários</b>, coloque o e‑mail da conta do canal e tente de novo.</p>
          <button type="button" className="btn btn-small" onClick={() => void window.studio.youtubeCancel()}>Cancelar login</button>
        </div>
      )}
      {error && <p className="device-error">{error}</p>}
    </div>
  );
}


/** Canais do YouTube: um cartão por canal (cada um com o próprio login e a própria live) e "Adicionar canal". */
function YoutubeChannels({ destinations, onDestinations }: { destinations: Destination[]; onDestinations: (list: Destination[]) => void }) {
  const [accounts, setAccounts] = useState<YoutubeState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void window.studio.youtubeAccounts().then(setAccounts, (e) => setError(ipcError(e)));
  useEffect(load, []);
  if (!accounts) return null;
  return (
    <div className="yt-channels">
      <h3 className="group-title"><MonitorPlay size={14} /> Canais do YouTube <span>{accounts.length}</span></h3>
      {accounts.length === 0 && <p className="empty-text">Nenhum canal conectado. Adicione um canal para puxar e criar as lives dele.</p>}
      {accounts.map((a, i) => (
        <YoutubePanel
          key={a.id}
          account={a}
          number={i + 1}
          destinations={destinations}
          onDestinations={onDestinations}
          onRemove={() => {
            if (!window.confirm(`Tirar ${a.channel?.title ?? `o Canal ${i + 1}`} do Estúdio? O acesso guardado neste Mac é apagado (o canal no YouTube não muda).`)) return;
            void window.studio.youtubeRemove(a.id).then((r) => { setAccounts(r.accounts); onDestinations(r.destinations); }, (e) => setError(ipcError(e)));
          }}
        />
      ))}
      <button type="button" className="btn btn-small" onClick={() => void window.studio.youtubeAdd().then(setAccounts, (e) => setError(ipcError(e)))}><Plus size={13} /> Adicionar canal do YouTube</button>
      {error && <p className="device-error">{error}</p>}
    </div>
  );
}

/** Baixar e importar as chaves de acesso (canais do YouTube e destinos) num arquivo protegido por senha. */
function KeysBar({ onImported }: { onImported: () => void }) {
  const [mode, setMode] = useState<null | 'baixar' | { file: string }>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const close = () => { setMode(null); setPassword(''); setConfirm(''); };
  const fail = (e: unknown) => setMessage({ ok: false, text: ipcError(e) });
  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'baixar') {
        const r = await window.studio.keysExport(password);
        if (r) setMessage({ ok: true, text: `Chaves baixadas (${r.channels} ${r.channels === 1 ? 'canal' : 'canais'}, ${r.destinations} ${r.destinations === 1 ? 'destino' : 'destinos'}): ${r.path}` });
        if (r) close();
      } else if (mode) {
        const r = await window.studio.keysImport(password);
        setMessage({ ok: true, text: `Importado: ${r.channels} ${r.channels === 1 ? 'canal' : 'canais'} do YouTube e ${r.destinations} ${r.destinations === 1 ? 'destino' : 'destinos'}.` });
        close();
        onImported();
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const exporting = mode === 'baixar';
  const ready = password.length >= 6 && (!exporting || password === confirm);
  return (
    <div className="keys-bar">
      <div className="row-actions">
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => { setMessage(null); setMode('baixar'); }}><Download size={13} /> Baixar chaves…</button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => { setMessage(null); void window.studio.keysPick().then((file) => file && setMode({ file }), fail); }}><Upload size={13} /> Importar chaves…</button>
      </div>
      {mode && (
        <form className="settings-form keys-form" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
          <p className="hint">{exporting
            ? 'O arquivo leva o acesso aos canais do YouTube e as chaves de todos os destinos. Ele fica criptografado com esta senha: guarde-a, sem ela o arquivo não abre.'
            : <>Senha do arquivo <b>{mode.file}</b>. Os canais e destinos dele são juntados aos daqui (o mesmo canal é atualizado).</>}</p>
          <label className="option-field"><span className="option-label">Senha</span><input className="field" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Pelo menos 6 caracteres" /></label>
          {exporting && <label className="option-field"><span className="option-label">Repita a senha</span><input className="field" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>}
          {exporting && confirm && password !== confirm && <p className="device-error">As senhas não são iguais.</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={close}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}>{busy ? 'Aguarde…' : exporting ? 'Baixar' : 'Importar'}</button>
          </div>
        </form>
      )}
      {message && <p className={message.ok ? 'hint keys-ok' : 'device-error'}>{message.text}</p>}
    </div>
  );
}

const EMPTY_INPUT: DestinationInput = { platform: 'youtube', name: '', server: PLATFORMS.youtube.server, key: '', enabled: true };

/** Destinos da transmissão. A chave é digitada aqui e vai direto para o Keychain; nunca volta para a tela. */
export function LiveDialog({ output, onOutput, onClose, onStart }: { output: OutputSettings; onOutput: (o: OutputSettings) => void; onClose: () => void; onStart?: () => void }) {
  const [list, setList] = useState<Destination[]>([]);
  const [form, setForm] = useState<DestinationInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  /** Muda depois de importar chaves: a lista de canais é lida de novo. */
  const [channelsKey, setChannelsKey] = useState(0);
  useEffect(() => { void window.studio.listDestinations().then(setList); }, []);

  const save = async () => {
    if (!form) return;
    try {
      setList(await window.studio.saveDestination(form));
      setForm(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  const preset = OUTPUT_PRESETS.findIndex((p) => p.width === output.width && p.height === output.height && p.fps === output.fps);
  return (
    <Modal title={onStart ? 'Antes de transmitir' : 'Transmissão'} onClose={onClose} wide>
      {onStart && (
        <p className="live-start-hint">
          Escolha para onde vai a transmissão: em cada <b>canal do YouTube</b>, use uma live que já existe ou crie uma nova, e ligue os canais e destinos que devem receber o vídeo (pode ser mais de um ao mesmo tempo). Confira a qualidade ao lado e clique em <b>Transmitir agora</b>.
        </p>
      )}
      <div className="live-layout">
        <section>
          <KeysBar onImported={() => { void window.studio.listDestinations().then(setList); setChannelsKey((k) => k + 1); }} />
          <YoutubeChannels key={channelsKey} destinations={list} onDestinations={setList} />
          <h3 className="group-title">Destinos</h3>
          {list.length === 0 && !form && <p className="empty-text">Cadastre YouTube, Facebook, Instagram, Twitch ou outro servidor RTMP.</p>}
          <ul className="destination-list">
            {list.map((d) => (
              <li key={d.id} className={d.enabled ? '' : 'destination-off'}>
                <input type="checkbox" className="switch" checked={d.enabled} aria-label={`Transmitir para ${d.name}`} onChange={async (e) => setList(await window.studio.saveDestination({ id: d.id, platform: d.platform, name: d.name, server: d.server, key: '', enabled: e.target.checked }))} />
                <div className="destination-name">
                  <strong>{d.name}</strong>
                  <span>{PLATFORMS[d.platform].label} · chave <KeyRound size={11} /> ••••{d.keyHint}</span>
                </div>
                <button type="button" className="icon-btn" aria-label={`Editar ${d.name}`} title="Editar" onClick={() => setForm({ id: d.id, platform: d.platform, name: d.name, server: d.server, key: '', enabled: d.enabled })}><Pencil size={14} /></button>
                <button type="button" className="icon-btn icon-btn-remove" aria-label={`Excluir ${d.name}`} title="Excluir" onClick={async () => setList(await window.studio.deleteDestination(d.id))}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
          {form ? (
            <form className="settings-form destination-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <label className="option-field">
                <span className="option-label">Plataforma</span>
                <select className="option-select" value={form.platform} onChange={(e) => {
                  const platform = e.target.value as Platform;
                  setForm({ ...form, platform, server: PLATFORMS[platform].server || (form.server && !Object.values(PLATFORMS).some((p) => p.server === form.server) ? form.server : '') });
                }}>
                  {(Object.keys(PLATFORMS) as Platform[]).map((p) => <option key={p} value={p}>{PLATFORMS[p].label}</option>)}
                </select>
              </label>
              <label className="option-field"><span className="option-label">Nome</span><input className="field" value={form.name} placeholder={PLATFORMS[form.platform].label} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} /></label>
              <label className="option-field">
                <span className="option-label">Servidor (URL do stream)</span>
                <input className="field" value={form.server} placeholder="rtmps://…" onChange={(e) => setForm({ ...form, server: e.target.value.trim() })} />
              </label>
              <label className="option-field">
                <span className="option-label">Chave de transmissão</span>
                <input className="field" type="password" autoComplete="off" spellCheck={false} value={form.key} placeholder={form.id ? 'Deixe vazio para manter a chave guardada' : 'Cole a chave aqui'} onChange={(e) => setForm({ ...form, key: e.target.value })} />
              </label>
              <p className="hint">A chave é criptografada no Keychain do macOS e nunca mais aparece na tela, nem nos arquivos do projeto.</p>
              {error && <p className="device-error">{error}</p>}
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => { setForm(null); setError(null); }}>Cancelar</button>
                <button type="submit" className="btn btn-primary">Salvar destino</button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn btn-small" onClick={() => setForm({ ...EMPTY_INPUT })}>+ Novo destino</button>
          )}
        </section>
        <section>
          <h3 className="group-title">Qualidade</h3>
          <div className="settings-form">
            <label className="option-field">
              <span className="option-label">Resolução e quadros</span>
              <select className="option-select" value={preset >= 0 ? preset : ''} onChange={(e) => {
                const p = OUTPUT_PRESETS[Number(e.target.value)];
                if (p) onOutput({ ...output, width: p.width, height: p.height, fps: p.fps, bitrate: p.bitrate });
              }}>
                {preset < 0 && <option value="">{output.width}×{output.height} · {output.fps} fps</option>}
                {OUTPUT_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </select>
            </label>
            <label className="option-field">
              <span className="option-label">Taxa de bits do vídeo <output>{(output.bitrate / 1000).toLocaleString('pt-BR')} Mbps</output></span>
              <input type="range" min={1500} max={12000} step={500} value={output.bitrate} onChange={(e) => onOutput({ ...output, bitrate: Number(e.target.value) })} />
            </label>
            <label className="option-field">
              <span className="option-label">Codificador</span>
              <select className="option-select" value={output.encoder} onChange={(e) => onOutput({ ...output, encoder: e.target.value as OutputSettings['encoder'] })}>
                <option value="hardware">Hardware do Mac (VideoToolbox) — recomendado</option>
                <option value="x264">Software (x264) — usa mais processador</option>
              </select>
            </label>
            <p className="hint">YouTube recomenda 4,5–9 Mbps em 1080p. Se a internet oscilar, diminua a taxa.</p>
          </div>
          <details className="defaults" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void window.studio.readLiveLog().then(setLog); }}>
            <summary>Registro da última transmissão</summary>
            <pre className="live-log">{log === null ? 'Carregando…' : log.trim() || 'Nenhuma transmissão ainda.'}</pre>
          </details>
        </section>
      </div>
      {onStart ? (
        <div className="modal-actions">
          {!list.some((d) => d.enabled) && <span className="hint live-start-missing">Ligue ou cadastre pelo menos um destino.</span>}
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={!list.some((d) => d.enabled)} onClick={onStart}><Radio size={14} /> Transmitir agora</button>
        </div>
      ) : (
        <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Concluir</button></div>
      )}
    </Modal>
  );
}

/** Dispositivos tirados da lista, para trazer de volta. */
export function HiddenDialog({ hidden, onRestore, onClose }: { hidden: string[]; onRestore: (label: string) => void; onClose: () => void }) {
  return (
    <Modal title="Dispositivos removidos" onClose={onClose}>
      {hidden.length === 0 ? <p className="empty-text">Nenhum.</p> : (
        <ul className="phone-list">
          {hidden.map((h) => (
            <li key={h}><span>{h}</span><button type="button" className="btn btn-small" onClick={() => onRestore(h)}>Mostrar de novo</button></li>
          ))}
        </ul>
      )}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Concluir</button></div>
    </Modal>
  );
}

/** Configurações › Google Drive: cadastrar a chave (cliente OAuth), entrar na conta e escolher a pasta dos replays. */
export function DriveDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<DriveState | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [folder, setFolder] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasYoutube, setHasYoutube] = useState(false);
  const apply = (s: DriveState) => { setState(s); setClientId(s.clientId); setFolder(s.folderName); };
  useEffect(() => {
    void window.studio.driveState().then(apply, (e) => setError(ipcError(e)));
    void window.studio.youtubeAccounts().then((list) => setHasYoutube(list.some((a) => a.configured)), () => undefined);
  }, []);
  const run = async (label: string, task: () => Promise<DriveState>) => {
    setBusy(label);
    setError(null);
    try {
      apply(await task());
      return true;
    } catch (e) {
      setError(ipcError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  if (!state) return <Modal title="Google Drive" onClose={onClose}>{error ? <p className="device-error">{error}</p> : <p className="hint">Carregando…</p>}</Modal>;
  const credentials = !state.configured || editing;
  return (
    <Modal title="Google Drive" onClose={onClose}>
      <p className="hint">Os replays marcados na área Replay vão para uma pasta do seu Google Drive (botão <b>Enviar ao Drive</b>). O Estúdio só enxerga os arquivos e a pasta que ele mesmo criar.</p>
      {credentials ? (
        <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void run('Salvando…', () => window.studio.driveSetClient(clientId, secret)).then((ok) => { if (ok) { setSecret(''); setEditing(false); } }); }}>
          <h3 className="group-title"><KeyRound size={14} /> Chave de acesso</h3>
          {hasYoutube && (
            <div className="row-actions">
              <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => void run('Salvando…', () => window.studio.driveUseYoutubeClient()).then((ok) => ok && setEditing(false))}>Usar a mesma chave do YouTube</button>
              <span className="hint">Ative também a <b>Google Drive API</b> nesse projeto do Google Cloud.</span>
            </div>
          )}
          <ol className="steps">
            <li>Em <b>console.cloud.google.com</b>, use (ou crie) um projeto e ative a <b>Google Drive API</b>.</li>
            <li>Em <b>Tela de consentimento OAuth</b>: tipo Externo, e adicione o seu e‑mail em <b>Usuários de teste</b>.</li>
            <li>Em <b>Credenciais → Criar credenciais → ID do cliente OAuth</b>, escolha <b>App para computador</b>.</li>
            <li>Cole aqui o <b>ID do cliente</b> e a <b>Chave secreta do cliente</b>.</li>
          </ol>
          <label className="option-field"><span className="option-label">ID do cliente</span><input className="field" value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="123456-abc.apps.googleusercontent.com" /></label>
          <label className="option-field"><span className="option-label">Chave secreta do cliente</span><input className="field" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value.trim())} placeholder="GOCSPX-…" /></label>
          <div className="modal-actions">
            {state.configured && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancelar</button>}
            <button type="submit" className="btn btn-primary" disabled={!clientId || !secret || Boolean(busy)}>Salvar chave</button>
          </div>
        </form>
      ) : (
        <div className="settings-form">
          <h3 className="group-title"><KeyRound size={14} /> Chave de acesso</h3>
          <p className="hint">Cliente <code>{state.clientId.replace(/^(.{10}).*(\.apps\.googleusercontent\.com)$/, '$1…$2')}</code> · secreta guardada no Keychain <button type="button" className="link-btn" onClick={() => setEditing(true)}>Trocar chave</button></p>
          <h3 className="group-title"><CloudUpload size={14} /> Conta</h3>
          {state.connected ? (
            <div className="row-actions">
              <span>Conectado{state.email ? <> como <b>{state.email}</b></> : ''}</span>
              <button type="button" className="icon-btn icon-btn-remove" title="Desconectar" aria-label="Desconectar o Google Drive" onClick={() => void run('Desconectando…', () => window.studio.driveDisconnect())}><LogOut size={14} /></button>
            </div>
          ) : (
            <div className="row-actions">
              <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void run('Aguardando a autorização no navegador…', () => window.studio.driveConnect())}><CloudUpload size={14} /> Entrar com a conta do Google</button>
              {busy?.startsWith('Aguardando') && <button type="button" className="btn btn-small" onClick={() => void window.studio.driveCancel()}>Cancelar login</button>}
            </div>
          )}
          {state.connected && (
            <>
              <label className="switch-row">
                <span>Enviar cada replay automaticamente<small>Ao cortar um replay, ele vai sozinho para a pasta do projeto no Drive.</small></span>
                <input type="checkbox" className="switch" checked={state.auto} onChange={(e) => void run('Salvando…', () => window.studio.driveSetAuto(e.target.checked))} />
              </label>
              <DriveProjectLink />
            </>
          )}
          <form className="option-field" onSubmit={(e) => { e.preventDefault(); void run('Salvando…', () => window.studio.driveSetFolder(folder)); }}>
            <span className="option-label">Pasta no Drive</span>
            <span className="row-actions">
              <input className="field" value={folder} maxLength={100} onChange={(e) => setFolder(e.target.value)} />
              <button type="submit" className="btn btn-small" disabled={folder.trim() === state.folderName || Boolean(busy)}>Salvar</button>
            </span>
          </form>
        </div>
      )}
      {busy && <p className="hint">{busy}</p>}
      {error && <p className="device-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Concluir</button></div>
    </Modal>
  );
}

/** Página dos replays: link secreto e QR Code para abrir a lista da pasta de replays no celular ou outro computador. */
/** Página pública dos replays (replay-site no Easypanel, lê a pasta do Google Drive). */
export const PUBLIC_REPLAY_URL = 'https://replay.maisbasquete.com.br';

export function ReplayGalleryDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'publica' | 'local'>('publica');
  const [link, setLink] = useState<ReplayGalleryLink | null>(null);
  const [chosen, setChosen] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Link público já aponta para a transmissão atual (pasta do projeto no Drive; o Estúdio cria se ainda não existir).
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [publicNote, setPublicNote] = useState<string | null>(null);
  useEffect(() => {
    void window.studio.driveProjectFolder(false).then(
      (info) => {
        const id = /\/folders\/([\w-]+)/.exec(info.url)?.[1];
        setPublicUrl(id ? `${PUBLIC_REPLAY_URL}/?p=${id}` : PUBLIC_REPLAY_URL);
        setPublicNote(id ? `Abre direto na transmissão “${info.project}”.` : null);
      },
      () => {
        setPublicUrl(PUBLIC_REPLAY_URL);
        setPublicNote('Google Drive não conectado: o link abre na transmissão mais recente do Drive (Configurações › Google Drive).');
      },
    );
  }, []);
  useEffect(() => { if (mode === 'local' && !link) void window.studio.replayGalleryLink().then(setLink); }, [mode, link]);
  const url = mode === 'publica' ? publicUrl : link?.urls[chosen] ?? link?.urls[0] ?? null;
  useEffect(() => {
    if (!url) return setQr(null);
    void QRCode.toDataURL(url, { margin: 1, width: 520, color: { dark: '#0b0c0e', light: '#ffffff' } }).then(setQr);
  }, [url]);
  return (
    <Modal title="Página dos replays" onClose={onClose} wide>
      <div className="segmented" role="tablist" aria-label="Qual página">
        <button type="button" role="tab" aria-selected={mode === 'publica'} className={`btn btn-small ${mode === 'publica' ? 'btn-on' : ''}`} onClick={() => setMode('publica')}>Pública (internet)</button>
        <button type="button" role="tab" aria-selected={mode === 'local'} className={`btn btn-small ${mode === 'local' ? 'btn-on' : ''}`} onClick={() => setMode('local')}>Só neste Wi‑Fi</button>
      </div>
      <div className="phone-layout">
        <div className="phone-qr">
          {qr ? <img src={qr} alt="QR Code da página dos replays" /> : <div className="qr-empty">{link?.error ?? (link && link.urls.length === 0 ? 'Sem rede' : 'Preparando o link…')}</div>}
        </div>
        <div className="phone-info">
          {mode === 'publica' ? (
            <p className="modal-text">Qualquer pessoa com este link vê os replays <b>da transmissão mais recente</b> (e pode escolher as anteriores), separados pelas pastas da área Replay, para assistir e baixar. Mostra os replays <b>já enviados ao Google Drive</b> (o envio é automático depois de cada corte) e funciona mesmo com este computador desligado.</p>
          ) : (
            <p className="modal-text">Abra este link num celular ou computador <b>no mesmo Wi‑Fi</b> para ver todos os replays deste computador na hora do corte, mesmo antes de irem para o Google Drive.</p>
          )}
          {mode === 'local' && link && link.urls.length > 1 && (
            <label className="option-field">
              <span className="option-label">Rede deste computador</span>
              <select className="option-select" value={chosen} onChange={(e) => setChosen(Number(e.target.value))}>
                {link.urls.map((u, i) => <option key={u} value={i}>{new URL(u).hostname}</option>)}
              </select>
            </label>
          )}
          {mode === 'local' && link && link.urls.length === 0 && <p className="device-error">{link.running ? 'Este computador não está conectado a nenhuma rede Wi‑Fi ou cabo.' : link.error ?? 'O servidor local não está ligado.'}</p>}
          {url && (
            <div className="link-row">
              <input className="field" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Link da página dos replays" />
              <button type="button" className="btn btn-small" onClick={() => { void window.studio.copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Copy size={13} /> {copied ? 'Copiado' : 'Copiar'}</button>
              {mode === 'publica' && <button type="button" className="btn btn-small" onClick={() => void window.studio.openExternal(url)}>Abrir</button>}
            </div>
          )}
          {mode === 'publica' && publicNote && <p className="hint">{publicNote}</p>}
          {mode === 'local' && (
            <>
              <p className="hint">Só quem tem este link consegue abrir a página. Na primeira vez o navegador avisa que a conexão “não é particular” (o certificado é deste computador): toque em <b>Mostrar detalhes / Avançado</b> e depois em <b>visitar o site / Continuar</b>.</p>
              <button type="button" className="link-btn" onClick={() => void window.studio.replayGalleryNewLink().then(setLink)} title="O link antigo para de funcionar na hora"><RefreshCw size={12} /> Gerar novo link (o antigo para de funcionar)</button>
            </>
          )}
        </div>
      </div>
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Concluir</button></div>
    </Modal>
  );
}

/** Link da pasta do projeto no Google Drive (onde ficam os replays dele): abrir, copiar e compartilhar. */
export function DriveProjectLink() {
  const [info, setInfo] = useState<{ url: string; shared: boolean; project: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = (share = false) => {
    setBusy(true);
    setError(null);
    window.studio.driveProjectFolder(share).then(setInfo, (e) => setError(ipcError(e))).finally(() => setBusy(false));
  };
  useEffect(() => load(), []);
  return (
    <div className="option-field">
      <span className="option-label">Pasta do projeto no Drive{info ? <> · <b>{info.project}</b></> : ''}</span>
      {info ? (
        <>
          <div className="link-row">
            <input className="field" readOnly value={info.url} onFocus={(e) => e.currentTarget.select()} aria-label="Link da pasta do projeto no Drive" />
            <button type="button" className="btn btn-small" onClick={() => { void window.studio.copyText(info.url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Copy size={13} /> {copied ? 'Copiado' : 'Copiar'}</button>
            <button type="button" className="btn btn-small" onClick={() => void window.studio.driveOpenFolder().catch((e) => setError(ipcError(e)))}><Globe size={13} /> Abrir</button>
          </div>
          {info.shared
            ? <p className="hint">Qualquer pessoa com este link pode ver e baixar os vídeos da pasta.</p>
            : (
              <div className="row-actions">
                <span className="hint">Só você (a conta conectada) abre este link.</span>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => { if (window.confirm('Deixar a pasta do projeto visível para qualquer pessoa com o link? Os vídeos dela poderão ser vistos e baixados por quem receber o link.')) load(true); }}>Liberar para quem tiver o link</button>
              </div>
            )}
        </>
      ) : <p className="hint">{busy ? 'Buscando a pasta…' : ''}</p>}
      {error && <p className="device-error">{error}</p>}
    </div>
  );
}

/** Projeto › Nova transmissão: guarda a atual (configuração + replays) e começa outra igual, sem replays. */
export function NewSessionDialog({ project, onDone, onClose }: { project: Project; onDone: (name: string) => void; onClose: () => void }) {
  const stamp = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const [name, setName] = useState(`Transmissão ${stamp}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Nova transmissão" onClose={onClose}>
      <form className="settings-form" onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        window.studio.sessionNew(name, project).then((info) => onDone(info.name), (err) => { setError(ipcError(err)); setBusy(false); });
      }}>
        <p className="modal-text">A transmissão atual (<b>{project.name}</b>) é guardada com toda a configuração e os replays dela, e pode ser recuperada em <b>Projeto › Transmissões anteriores</b>. A nova começa com a mesma configuração (cenas, fontes, widgets, mídias, destinos) e <b>sem replays</b>.</p>
        <label className="option-field"><span className="option-label">Nome da nova transmissão (também é a pasta dela no Google Drive)</span><input className="field" value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} /></label>
        {error && <p className="device-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>{busy ? 'Aguarde…' : 'Começar nova transmissão'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Projeto › Transmissões anteriores: recuperar (configuração + replays) ou apagar. */
export function SessionsDialog({ project, onRestored, onClose }: { project: Project; onRestored: (project: Project) => void; onClose: () => void }) {
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void window.studio.sessionList().then(setList, (e) => setError(ipcError(e))); }, []);
  const size = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / 1048576)} MB`);
  const when = (ms: number) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <Modal title="Transmissões anteriores" onClose={onClose} wide>
      <p className="modal-text">Ao recuperar, a transmissão atual (<b>{project.name}</b>) é guardada aqui e a escolhida volta com toda a configuração e os replays dela.</p>
      {list === null ? <p className="hint">Carregando…</p> : list.length === 0 ? <p className="empty-text">Nenhuma transmissão guardada ainda. Use <b>Projeto › Nova transmissão</b> para guardar a atual e começar outra.</p> : (
        <ul className="destination-list">
          {list.map((s) => (
            <li key={s.id}>
              <div className="destination-name">
                <strong>{s.name}</strong>
                <span>Começou {when(s.createdAt)} · guardada {when(s.archivedAt)} · {s.replays} {s.replays === 1 ? 'replay' : 'replays'}{s.bytes ? ` (${size(s.bytes)})` : ''}</span>
              </div>
              <button type="button" className="btn btn-small btn-primary" disabled={Boolean(busy)} onClick={() => {
                setBusy(s.id);
                setError(null);
                window.studio.sessionRestore(s.id, project).then((r) => onRestored(r.project), (e) => { setError(ipcError(e)); setBusy(null); });
              }}>{busy === s.id ? 'Recuperando…' : 'Recuperar'}</button>
              <button type="button" className="icon-btn icon-btn-remove" disabled={Boolean(busy)} aria-label={`Apagar ${s.name}`} title="Apagar de vez (configuração e replays)" onClick={() => {
                if (!window.confirm(`Apagar de vez a transmissão "${s.name}" e os ${s.replays} replays dela? Os vídeos já enviados ao Google Drive continuam lá.`)) return;
                void window.studio.sessionRemove(s.id).then(setList, (e) => setError(ipcError(e)));
              }}><Trash2 size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="device-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}
