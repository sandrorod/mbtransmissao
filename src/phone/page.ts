/**
 * Página que o celular abre pelo link/QR Code. HTML e JavaScript puros, sem dependências,
 * servidos pelo próprio Estúdio. O token fica no endereço (/c/<token>).
 */
export const PHONE_PAGE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0c0e">
<title>Câmera · Estúdio ao Vivo</title>
<style>
  :root { --bg:#0b0c0e; --panel:#15171a; --panel-2:#1d2024; --line:#2a2e33; --text:#f1f2f4; --muted:#9aa1a9; --accent:#19b5b0; --accent-ink:#021514; --danger:#ff6b5e; --ok:#4cc38a; --warn:#f5a524; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  main { display:flex; flex-direction:column; gap:12px; max-width:560px; margin:0 auto; padding:16px 16px calc(16px + env(safe-area-inset-bottom)); min-height:100%; }
  h1 { margin:0; font-size:18px; display:flex; align-items:center; gap:8px; }
  h1 i { width:10px; height:10px; border-radius:50%; background:var(--accent); display:inline-block; }
  .status { display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); font-size:14px; }
  .status b { width:10px; height:10px; border-radius:50%; background:var(--muted); flex:none; }
  .status[data-s=ok] b { background:var(--ok); } .status[data-s=wait] b { background:var(--warn); } .status[data-s=err] b { background:var(--danger); }
  .stage { position:relative; width:100%; aspect-ratio:16/9; background:#000; border-radius:8px; overflow:hidden; }
  video { width:100%; height:100%; object-fit:contain; background:#000; }
  .live { position:absolute; top:8px; left:8px; padding:3px 8px; border-radius:4px; background:var(--accent); color:var(--accent-ink); font-size:12px; font-weight:700; display:none; }
  .stage.on .live { display:block; }
  label { display:flex; flex-direction:column; gap:6px; font-size:13px; color:var(--muted); }
  input { height:44px; padding:0 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel-2); color:var(--text); font:inherit; font-size:16px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  button { flex:1; min-height:48px; padding:0 14px; border:1px solid var(--line); border-radius:8px; background:var(--panel-2); color:var(--text); font:inherit; font-weight:600; font-size:15px; }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
  button.danger { background:var(--danger); border-color:var(--danger); color:#1c0604; }
  button:disabled { opacity:.45; }
  .hint { color:var(--muted); font-size:13px; line-height:1.45; margin:0; }
  .hidden { display:none !important; }
  /* No ar: o operador pôs esta câmera no Programa. Tela inteira verde e "AO VIVO" na imagem. */
  html.on-air, html.on-air body { background:#0d6b34; }
  html.on-air .status { background:#0a5529; border-color:#22c55e; }
  html.on-air .status b { background:#4ade80; }
  html.on-air button:not(.primary):not(.danger):not(.msg-btn):not(.on) { background:#0a5529; border-color:#22c55e; }
  html.on-air input { background:#0a5529; border-color:#22c55e; }
  html.on-air .hint { color:#c9f2d6; }
  .onair { position:absolute; top:10px; right:10px; display:none; align-items:center; gap:7px; padding:6px 12px; border-radius:6px; background:#16a34a; border:2px solid #fff; color:#fff; font-size:16px; font-weight:800; letter-spacing:.06em; box-shadow:0 2px 10px rgba(0,0,0,.45); }
  .onair i { width:10px; height:10px; border-radius:50%; background:#fff; animation:blink 1s steps(2,start) infinite; }
  html.on-air .onair { display:flex; }
  html.on-air .live { display:none !important; }
  @keyframes blink { to { visibility:hidden; } }
  button.on { background:var(--accent) !important; border-color:var(--accent) !important; color:var(--accent-ink); }
  .msg-btn { position:absolute; right:10px; bottom:10px; z-index:3; flex:none; width:52px; height:52px; min-height:0; padding:0; display:none; align-items:center; justify-content:center; border-radius:50%; border:2px solid rgba(255,255,255,.85); background:rgba(0,0,0,.55); color:#fff; }
  .stage.ready .msg-btn { display:flex; }
  .msg-btn svg { width:26px; height:26px; }
  .msg-btn .badge { position:absolute; top:-6px; right:-6px; margin:0; }
  /* Mensagem nova: pisca em amarelo forte até a pessoa abrir. */
  .msg-btn.alert { animation:alert .6s ease-in-out infinite alternate; }
  @keyframes alert { from { background:#ffd400; color:#1a1400; border-color:#ffd400; box-shadow:0 0 0 0 rgba(255,212,0,.9); transform:scale(1); } to { background:#ff3b30; color:#fff; border-color:#fff; box-shadow:0 0 0 10px rgba(255,59,48,0); transform:scale(1.12); } }
  .listen-box { display:flex; flex-direction:column; gap:8px; }
  .meter { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); }
  .meter-bar { position:relative; flex:1; height:10px; border-radius:5px; background:#0e1012; overflow:hidden; }
  .meter-fill { position:absolute; inset:0 auto 0 0; width:0; background:var(--ok); transition:width .05s linear; }
  .meter-fill[data-zone=hot] { background:var(--warn); } .meter-fill[data-zone=clip] { background:var(--danger); }
  html.on-air .meter { color:#c9f2d6; }
  .badge { display:inline-block; min-width:20px; height:20px; margin-left:6px; padding:0 6px; border-radius:10px; background:var(--danger); color:#fff; font-size:12px; line-height:20px; vertical-align:middle; }
  .sheet { position:fixed; inset:0; z-index:10; display:flex; flex-direction:column; background:rgba(0,0,0,.6); }
  .sheet-box { margin-top:auto; display:flex; flex-direction:column; height:75%; max-width:560px; width:100%; margin-left:auto; margin-right:auto; background:var(--panel); border:1px solid var(--line); border-radius:14px 14px 0 0; padding:12px 12px calc(12px + env(safe-area-inset-bottom)); gap:10px; }
  .sheet-head { display:flex; align-items:center; justify-content:space-between; font-weight:700; }
  .sheet-head button { flex:none; min-height:36px; padding:0 12px; }
  .msgs { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px; padding:4px 0; }
  .msg { max-width:82%; padding:8px 10px; border-radius:10px; font-size:15px; line-height:1.35; word-wrap:break-word; white-space:pre-wrap; }
  .msg small { display:block; font-size:11px; opacity:.7; margin-bottom:2px; }
  .msg.me { align-self:flex-end; background:var(--accent); color:var(--accent-ink); }
  .msg.them { align-self:flex-start; background:var(--panel-2); border:1px solid var(--line); }
  .msgs-empty { margin:auto; color:var(--muted); font-size:14px; text-align:center; }
  .send { display:flex; gap:8px; }
  .send input { flex:1; min-width:0; }
  .send button { flex:none; }
</style>
</head>
<body>
<main>
  <h1><i></i>Estúdio ao Vivo</h1>
  <div class="status" id="status" data-s="wait"><b></b><span id="status-text">Toque em “Compartilhar câmera” para entrar na transmissão.</span></div>
  <div class="stage" id="stage"><video id="preview" autoplay playsinline muted></video><span class="live">NO ESTÚDIO</span><span class="onair" id="onair"><i></i>AO VIVO</span><button class="msg-btn" id="chat" aria-label="Mensagens do Estúdio"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="badge hidden" id="unread"></span></button></div>
  <audio id="program" playsinline></audio>
  <label>Nome deste celular<input id="name" maxlength="40" autocomplete="off" placeholder="Ex.: Câmera da quadra"></label>
  <div class="row" id="start-row"><button class="primary" id="start">Compartilhar câmera</button></div>
  <div class="row hidden" id="controls">
    <button id="flip">Trocar câmera</button>
    <button id="mic">Microfone ligado</button>
  </div>
  <div class="listen-box hidden" id="extras">
    <div class="row"><button id="listen">Ouvir transmissão</button></div>
    <div class="meter" id="meter"><span>Som da transmissão</span><div class="meter-bar"><div class="meter-fill" id="meter-fill"></div></div></div>
  </div>
  <p class="hint hidden" id="listen-hint">Use fone de ouvido: sem ele, o som da transmissão volta pelo microfone deste celular.</p>
  <div class="row hidden" id="stop-row"><button class="danger" id="stop">Parar</button></div>
  <p class="hint">Mantenha esta página aberta e a tela ligada. O vídeo vai direto para o computador do Estúdio pela rede Wi‑Fi.</p>
</main>
<div class="sheet hidden" id="sheet">
  <div class="sheet-box" role="dialog" aria-label="Chat com o Estúdio">
    <div class="sheet-head"><span>Chat com o Estúdio</span><button id="chat-close">Fechar</button></div>
    <div class="msgs" id="msgs"></div>
    <form class="send" id="send"><input id="text" maxlength="500" autocomplete="off" placeholder="Escreva uma mensagem"><button class="primary" type="submit">Enviar</button></form>
  </div>
</div>
<script src="/celular.js"></script>
</body>
</html>`;

export const PHONE_PAGE_SCRIPT = `(() => {
  'use strict';
  const token = location.pathname.split('/')[2];
  const $ = (id) => document.getElementById(id);
  const storeKey = 'estudio-celular-id';
  let phoneId = localStorage.getItem(storeKey);
  if (!phoneId) { phoneId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, ''); localStorage.setItem(storeKey, phoneId); }
  const guess = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Celular';
  $('name').value = localStorage.getItem('estudio-celular-nome') || guess;

  let stream = null, pc = null, events = null, facing = 'environment', micOn = true, wakeLock = null, removed = false;
  // Som do Programa que o Estúdio devolve (trilha de retorno) e se a pessoa quer ouvir.
  let back = null, backTrack = null;
  // Ouvir a transmissão vem ligado; se a pessoa desligar, o celular lembra.
  let listening = localStorage.getItem('estudio-celular-ouvir') !== '0';
  let audioCtx = null, meterSource = null, analyser = null, meterFrame = 0;
  // Chat: histórico guardado neste celular (some ao limpar os dados do site).
  let chat = []; try { chat = JSON.parse(localStorage.getItem('estudio-celular-chat') || '[]'); if (!Array.isArray(chat)) chat = []; } catch (e) { chat = []; }
  let unread = 0;
  // Qualidade pedida pelo Estúdio (teto em Mbps e o que segurar quando o celular esquenta ou o Wi‑Fi aperta).
  let quality = { mbps: 6, prioridade: 'equilibrio' };
  const HINT = { nitidez: 'detail', equilibrio: '', fluidez: 'motion' };
  const DEGRADE = { nitidez: 'maintain-resolution', equilibrio: 'balanced', fluidez: 'maintain-framerate' };
  let statsTimer = 0, lastSent = null, battery = null;
  try { if (navigator.getBattery) navigator.getBattery().then((b) => { battery = b; }, () => {}); } catch (e) {}

  function status(text, s) { $('status-text').textContent = text; $('status').dataset.s = s; }
  async function post(message) {
    try { await fetch('/c/' + token + '/enviar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ id: phoneId }, message)) }); } catch (e) {}
  }

  async function capture() {
    const video = { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    // Ouvindo pelo alto-falante: o cancelamento de eco evita que o som da transmissão volte pelo microfone.
    const audio = { echoCancellation: listening, noiseSuppression: false, autoGainControl: false };
    try { return await navigator.mediaDevices.getUserMedia({ video, audio }); }
    catch (e) { if (e && e.name === 'NotAllowedError') throw e; return navigator.mediaDevices.getUserMedia({ video, audio: false }); }
  }

  function explain(e) {
    const n = e && e.name;
    if (!navigator.mediaDevices) return 'Este navegador bloqueou a câmera nesta página. Abra o link no Safari (iPhone) ou no Chrome (Android).';
    if (n === 'NotAllowedError') return 'Permissão negada. Libere câmera e microfone para este site nos ajustes do navegador e tente de novo.';
    if (n === 'NotReadableError') return 'A câmera está em uso por outro aplicativo. Feche-o e tente de novo.';
    return 'Não foi possível abrir a câmera: ' + (e && e.message ? e.message : e);
  }

  async function keepAwake() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) {}
  }

  // iPhone: som só toca se for liberado num toque. O toque em "Compartilhar câmera" libera o som e o medidor.
  function unlockAudio() {
    try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume().catch(() => {}); } catch (e) {}
    const el = $('program');
    if (!el.srcObject) el.srcObject = new MediaStream();
    el.muted = !listening;
    el.play().catch(() => {});
  }

  async function start() {
    removed = false;
    unlockAudio();
    $('start').disabled = true;
    try {
      stream = await capture();
    } catch (e) {
      status(explain(e), 'err');
      $('start').disabled = false;
      return;
    }
    $('preview').srcObject = stream;
    $('start-row').classList.add('hidden');
    $('controls').classList.remove('hidden');
    $('extras').classList.remove('hidden');
    $('stage').classList.add('ready');
    renderListen();
    $('stop-row').classList.remove('hidden');
    $('mic').disabled = stream.getAudioTracks().length === 0;
    if ($('mic').disabled) $('mic').textContent = 'Sem microfone';
    localStorage.setItem('estudio-celular-nome', $('name').value.trim());
    keepAwake();
    connect();
  }

  // Pelo link público (túnel) as mensagens contínuas não passam: aí o celular busca as mensagens (consulta longa).
  const remote = !/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(location.hostname) && location.hostname !== 'localhost';
  let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
  async function loadIce() {
    try { const r = await fetch('/c/' + token + '/ice', { cache: 'no-store' }); const list = await r.json(); if (Array.isArray(list) && list.length) ice = list; } catch (e) {}
  }

  function onMessage(m) {
    if (!m) return;
    if (m.t === 'pronto') offer().catch((e) => post({ t: 'falha', texto: 'oferta: ' + (e && e.message ? e.message : e) }));
    else if (m.t === 'sinal') signal(m.dados);
    else if (m.t === 'comando') command(m.acao);
    else if (m.t === 'no-ar') setOnAir(m.on === true);
    else if (m.t === 'qualidade') { const mbps = Number(m.mbps); quality = { mbps: mbps >= 2 && mbps <= 20 ? mbps : 6, prioridade: HINT[m.prioridade] !== undefined ? m.prioridade : 'equilibrio' }; if (pc) tune(pc); }
    else if (m.t === 'chat' && typeof m.texto === 'string') addMessage('them', m.texto);
    else if (m.t === 'removido') { removed = true; stop('O operador removeu este celular do Estúdio.'); }
  }

  let pollRound = 0;
  function connect() {
    if (events) events.close();
    status('Conectando ao Estúdio…', 'wait');
    const query = '?id=' + encodeURIComponent(phoneId) + '&nome=' + encodeURIComponent($('name').value.trim() || guess);
    if (!remote) {
      const source = new EventSource('/c/' + token + '/eventos' + query);
      events = source;
      source.onopen = () => status('Aguardando o Estúdio…', 'wait');
      source.onerror = () => { if (!removed) status('Sem conexão com o Estúdio. Tentando de novo…', 'err'); };
      source.onmessage = (event) => { let m; try { m = JSON.parse(event.data); } catch (e) { return; } onMessage(m); };
      return;
    }
    const round = ++pollRound;
    events = { close: () => { if (pollRound === round) pollRound++; } };
    (async () => {
      let waiting = true;
      while (round === pollRound) {
        try {
          const r = await fetch('/c/' + token + '/espera' + query, { cache: 'no-store' });
          if (round !== pollRound) return;
          if (!r.ok) throw new Error(String(r.status));
          if (waiting) { status('Aguardando o Estúdio…', 'wait'); waiting = false; }
          const list = await r.json();
          if (Array.isArray(list)) for (const m of list) { if (round !== pollRound) return; onMessage(m); }
        } catch (e) {
          if (round !== pollRound) return;
          if (!removed) status('Sem conexão com o Estúdio. Tentando de novo…', 'err');
          waiting = true;
          await new Promise((done) => setTimeout(done, 2000));
        }
      }
    })();
  }

  async function offer() {
    if (!stream) return;
    if (pc) pc.close();
    await loadIce();
    if (!stream) return;
    const current = new RTCPeerConnection({ iceServers: ice });
    pc = current;
    stream.getTracks().forEach((t) => {
      // Dica ao codificador: nitidez (detail), equilíbrio ('') ou fluidez (motion), conforme o Estúdio pedir.
      if (t.kind === 'video' && 'contentHint' in t) t.contentHint = HINT[quality.prioridade] || '';
      current.addTrack(t, stream);
    });
    preferH264(current);
    // Canal de volta: o Estúdio manda por aqui o som do Programa (só quando a pessoa pede para ouvir).
    let backTr = null;
    try { backTr = current.addTransceiver('audio', { direction: 'recvonly' }); } catch (e) {}
    back = backTr;
    current.ontrack = (e) => { if (pc === current && backTr && e.transceiver === backTr) { backTrack = e.track; if (listening) playProgram(); } };
    current.onicecandidate = (e) => { if (e.candidate && pc === current) post({ t: 'sinal', dados: { candidate: e.candidate } }); };
    current.onconnectionstatechange = () => {
      if (pc !== current) return;
      const s = current.connectionState;
      window.estudioConexao = s;
      $('stage').classList.toggle('on', s === 'connected');
      if (s === 'connected') { status('No Estúdio · ' + ($('name').value.trim() || guess), 'ok'); tune(current); reportStats(current); if (listening) post({ t: 'ouvir', on: true }); }
      else if (s === 'failed') status('A conexão de vídeo caiu. Reconectando…', 'err');
      else if (s === 'connecting') status('Conectando o vídeo…', 'wait');
    };
    const description = await current.createOffer();
    await current.setLocalDescription(description);
    post({ t: 'sinal', dados: { sdp: current.localDescription, retorno: backTr && backTr.mid } });
  }

  // H.264 primeiro: o celular codifica por hardware. VP8 (o padrão) é por software e derruba os quadros em 1080p.
  function preferH264(connection) {
    try {
      const caps = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
      if (!caps) return;
      const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType));
      if (!h264.length) return;
      const rest = caps.codecs.filter((c) => !/h264/i.test(c.mimeType));
      connection.getTransceivers().forEach((tr) => {
        if (tr.sender.track && tr.sender.track.kind === 'video' && tr.setCodecPreferences) tr.setCodecPreferences(h264.concat(rest));
      });
    } catch (e) {}
  }

  // Qualidade pedida pelo Estúdio. Antes era sempre "manter quadros" + dica "motion": quando o celular esquentava ou o
  // Wi‑Fi oscilava, o WebRTC baixava a resolução (1080p → 720p → 540p) e a imagem ficava cada vez menos nítida.
  async function tune(connection) {
    for (const sender of connection.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      if ('contentHint' in sender.track) sender.track.contentHint = HINT[quality.prioridade] || '';
      // Cada tentativa relê os parâmetros (o navegador exige). Se recusar a prioridade, aplica ao menos a taxa.
      const build = (withPreference) => {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = Math.round(quality.mbps * 1000000);
        p.encodings[0].maxFramerate = 30;
        p.encodings[0].priority = 'high';
        p.encodings[0].networkPriority = 'high';
        if (withPreference) p.degradationPreference = DEGRADE[quality.prioridade] || 'balanced';
        return p;
      };
      let applied = 'nada';
      try { await sender.setParameters(build(true)); applied = 'tudo'; }
      catch (e) { try { await sender.setParameters(build(false)); applied = 'so-taxa'; } catch (e2) {} }
      const now = sender.getParameters();
      window.estudioAjuste = { aplicado: applied, prioridade: now.degradationPreference || null, teto: now.encodings && now.encodings[0] ? now.encodings[0].maxBitrate : null, dica: sender.track.contentHint };
    }
  }

  // A cada 5 s conta ao Estúdio o que está mandando e por que reduziu (processador/calor ou rede).
  function reportStats(connection) {
    clearInterval(statsTimer);
    lastSent = null;
    statsTimer = setInterval(async () => {
      if (pc !== connection || connection.connectionState !== 'connected') return;
      let out = null, rtt = 0;
      try {
        const report = await connection.getStats();
        report.forEach((r) => {
          if (r.type === 'outbound-rtp' && r.kind === 'video' && (!out || (r.frameWidth || 0) > (out.frameWidth || 0))) out = r;
          if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime) rtt = r.currentRoundTripTime * 1000;
        });
      } catch (e) { return; }
      if (!out) return;
      const now = performance.now();
      const kbps = lastSent ? ((out.bytesSent - lastSent.bytes) * 8) / (now - lastSent.at) : 0;
      lastSent = { bytes: out.bytesSent || 0, at: now };
      const reason = out.qualityLimitationReason;
      post({ t: 'estat', dados: {
        width: out.frameWidth || 0, height: out.frameHeight || 0, fps: out.framesPerSecond || 0, kbps: Math.max(0, kbps),
        targetKbps: out.targetBitrate ? out.targetBitrate / 1000 : 0,
        limit: reason === 'cpu' || reason === 'bandwidth' || reason === 'other' ? reason : 'none',
        rttMs: rtt, battery: battery ? battery.level : -1, charging: battery ? battery.charging : false,
      } });
    }, 5000);
  }

  async function signal(data) {
    if (!pc || !data) return;
    try {
      if (data.sdp) await pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch (e) { if (data.sdp) post({ t: 'falha', texto: 'resposta recusada: ' + (e && e.message ? e.message : e) }); }
  }

  async function flip() {
    facing = facing === 'environment' ? 'user' : 'environment';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
      const track = fresh.getVideoTracks()[0];
      const old = stream.getVideoTracks()[0];
      if (pc) { const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video'); if (sender) await sender.replaceTrack(track); }
      stream.removeTrack(old); old.stop(); stream.addTrack(track);
      $('preview').srcObject = stream;
    } catch (e) { facing = facing === 'environment' ? 'user' : 'environment'; status('Este aparelho não tem a outra câmera disponível.', 'err'); }
  }

  function setMic(on) {
    micOn = on;
    stream && stream.getAudioTracks().forEach((t) => (t.enabled = on));
    $('mic').textContent = on ? 'Microfone ligado' : 'Microfone desligado';
  }

  function command(action) {
    if (action === 'trocar-camera') flip();
    else if (action === 'mudo') setMic(false);
    else if (action === 'som') setMic(true);
  }

  function setOnAir(on) {
    document.documentElement.classList.toggle('on-air', on);
    $('onair').setAttribute('aria-hidden', on ? 'false' : 'true');
    document.querySelector('meta[name=theme-color]').setAttribute('content', on ? '#0d6b34' : '#0b0c0e');
    if (on && navigator.vibrate) navigator.vibrate(200);
  }

  function playProgram() {
    const el = $('program');
    if (!backTrack) return;
    if (!el.srcObject) el.srcObject = new MediaStream();
    const s = el.srcObject;
    if (!s.getAudioTracks().includes(backTrack)) { s.getAudioTracks().forEach((t) => s.removeTrack(t)); s.addTrack(backTrack); }
    el.muted = false;
    el.play().catch(() => {});
    startMeter();
  }

  // Medidor: mostra que o som da transmissão está chegando (como no mixer do Estúdio).
  function startMeter() {
    if (!backTrack) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume().catch(() => {});
      if (meterSource && meterSource.track === backTrack) return;
      if (meterSource) meterSource.node.disconnect();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      const node = audioCtx.createMediaStreamSource(new MediaStream([backTrack]));
      node.connect(analyser);
      meterSource = { node, track: backTrack };
    } catch (e) { return; }
    if (meterFrame) return;
    const data = new Float32Array(1024);
    let shown = 0;
    const tick = () => {
      meterFrame = requestAnimationFrame(tick);
      let peak = 0;
      if (analyser && listening) { analyser.getFloatTimeDomainData(data); for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; } }
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      const level = Math.max(0, Math.min(1, (db + 60) / 60));
      shown = level > shown ? level : shown * 0.9;
      const fill = $('meter-fill');
      fill.style.width = (shown * 100).toFixed(1) + '%';
      fill.dataset.zone = db > -3 ? 'clip' : db > -12 ? 'hot' : 'ok';
    };
    meterFrame = requestAnimationFrame(tick);
  }

  function renderListen() {
    $('listen').classList.toggle('on', listening);
    $('listen').textContent = listening ? 'Ouvindo a transmissão' : 'Ouvir transmissão';
    $('listen-hint').classList.toggle('hidden', !listening);
    $('meter').classList.toggle('hidden', !listening);
  }

  function setListening(on) {
    listening = on;
    localStorage.setItem('estudio-celular-ouvir', on ? '1' : '0');
    renderListen();
    const el = $('program');
    if (on) playProgram(); else { el.pause(); el.muted = true; }
    // Com o som tocando no alto-falante, o cancelamento de eco evita que ele volte pelo microfone.
    if (stream) stream.getAudioTracks().forEach((t) => { try { t.applyConstraints({ echoCancellation: on }).catch(() => {}); } catch (e) {} });
    post({ t: 'ouvir', on });
  }

  function renderChat() {
    const box = $('msgs');
    box.textContent = '';
    if (!chat.length) { const p = document.createElement('p'); p.className = 'msgs-empty'; p.textContent = 'Nenhuma mensagem ainda. Escreva para o operador do Estúdio.'; box.appendChild(p); }
    for (const m of chat) {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.from === 'me' ? 'me' : 'them');
      const small = document.createElement('small');
      small.textContent = (m.from === 'me' ? 'Você' : 'Estúdio') + ' · ' + new Date(m.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      div.appendChild(small);
      div.appendChild(document.createTextNode(m.text));
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
    $('unread').textContent = unread > 9 ? '9+' : String(unread);
    $('unread').classList.toggle('hidden', unread === 0);
    $('chat').classList.toggle('alert', unread > 0);
  }

  function addMessage(from, text) {
    chat.push({ from, text, at: Date.now() });
    if (chat.length > 200) chat = chat.slice(-200);
    try { localStorage.setItem('estudio-celular-chat', JSON.stringify(chat)); } catch (e) {}
    const open = !$('sheet').classList.contains('hidden');
    if (from === 'them' && !open) { unread++; if (navigator.vibrate) navigator.vibrate([80, 60, 80]); }
    renderChat();
  }

  function openChat(on) {
    $('sheet').classList.toggle('hidden', !on);
    if (on) { unread = 0; renderChat(); setTimeout(() => $('text').focus(), 50); }
  }

  function stop(message) {
    clearInterval(statsTimer);
    if (events) { events.close(); events = null; }
    if (pc) { pc.close(); pc = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('preview').srcObject = null;
    $('stage').classList.remove('on');
    setOnAir(false);
    $('program').pause(); $('program').srcObject = null; backTrack = null; back = null;
    if (meterSource) { meterSource.node.disconnect(); meterSource = null; }
    if (meterFrame) { cancelAnimationFrame(meterFrame); meterFrame = 0; }
    $('meter-fill').style.width = '0';
    $('stage').classList.remove('ready');
    openChat(false);
    $('extras').classList.add('hidden');
    $('controls').classList.add('hidden');
    $('stop-row').classList.add('hidden');
    $('start-row').classList.remove('hidden');
    $('start').disabled = false;
    status(message || 'Você saiu da transmissão. Toque em “Compartilhar câmera” para voltar.', message ? 'err' : 'wait');
  }

  let nameTimer = null;
  $('name').addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => { const n = $('name').value.trim(); localStorage.setItem('estudio-celular-nome', n); if (events) post({ t: 'nome', nome: n }); }, 500);
  });
  $('start').addEventListener('click', start);
  $('flip').addEventListener('click', flip);
  $('mic').addEventListener('click', () => setMic(!micOn));
  $('stop').addEventListener('click', () => stop());
  $('listen').addEventListener('click', () => setListening(!listening));
  $('chat').addEventListener('click', () => openChat(true));
  $('chat-close').addEventListener('click', () => openChat(false));
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) openChat(false); });
  $('send').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('text').value.trim();
    if (!text) return;
    $('text').value = '';
    addMessage('me', text);
    post({ t: 'chat', texto: text });
  });
  renderChat();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && stream) keepAwake(); });
  if (!window.isSecureContext || !navigator.mediaDevices) status('Abra este link pelo navegador do celular (Safari ou Chrome) e aceite o aviso de segurança da rede local.', 'err');
})();`;
