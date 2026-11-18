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
</style>
</head>
<body>
<main>
  <h1><i></i>Estúdio ao Vivo</h1>
  <div class="status" id="status" data-s="wait"><b></b><span id="status-text">Toque em “Compartilhar câmera” para entrar na transmissão.</span></div>
  <div class="stage" id="stage"><video id="preview" autoplay playsinline muted></video><span class="live">NO ESTÚDIO</span></div>
  <label>Nome deste celular<input id="name" maxlength="40" autocomplete="off" placeholder="Ex.: Câmera da quadra"></label>
  <div class="row" id="start-row"><button class="primary" id="start">Compartilhar câmera</button></div>
  <div class="row hidden" id="controls">
    <button id="flip">Trocar câmera</button>
    <button id="mic">Microfone ligado</button>
  </div>
  <div class="row hidden" id="stop-row"><button class="danger" id="stop">Parar</button></div>
  <p class="hint">Mantenha esta página aberta e a tela ligada. O vídeo vai direto para o computador do Estúdio pela rede Wi‑Fi.</p>
</main>
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

  function status(text, s) { $('status-text').textContent = text; $('status').dataset.s = s; }
  async function post(message) {
    try { await fetch('/c/' + token + '/enviar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ id: phoneId }, message)) }); } catch (e) {}
  }

  async function capture() {
    const video = { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
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

  async function start() {
    removed = false;
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
    if (m.t === 'pronto') offer();
    else if (m.t === 'sinal') signal(m.dados);
    else if (m.t === 'comando') command(m.acao);
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
      // Esporte: priorizar movimento fluido (quadros) em vez de detalhe parado.
      if (t.kind === 'video' && 'contentHint' in t) t.contentHint = 'motion';
      current.addTrack(t, stream);
    });
    preferH264(current);
    current.onicecandidate = (e) => { if (e.candidate && pc === current) post({ t: 'sinal', dados: { candidate: e.candidate } }); };
    current.onconnectionstatechange = () => {
      if (pc !== current) return;
      const s = current.connectionState;
      $('stage').classList.toggle('on', s === 'connected');
      if (s === 'connected') { status('No Estúdio · ' + ($('name').value.trim() || guess), 'ok'); tune(current); }
      else if (s === 'failed') status('A conexão de vídeo caiu. Reconectando…', 'err');
      else if (s === 'connecting') status('Conectando o vídeo…', 'wait');
    };
    const description = await current.createOffer();
    await current.setLocalDescription(description);
    post({ t: 'sinal', dados: { sdp: current.localDescription } });
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

  // Qualidade alta: na rede local cabe bem mais que o padrão do WebRTC.
  async function tune(connection) {
    for (const sender of connection.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      // 6 Mbps: 1080p30 fica nítido e sobra folga no Wi‑Fi (8 Mbps gerava rajadas de perda e travadinhas).
      p.encodings[0].maxBitrate = 6000000;
      p.encodings[0].maxFramerate = 30;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      // Se o celular ou o Wi‑Fi apertarem, reduz a resolução e mantém os quadros (movimento sem travar).
      p.degradationPreference = 'maintain-framerate';
      try { await sender.setParameters(p); } catch (e) {}
    }
  }

  async function signal(data) {
    if (!pc || !data) return;
    try {
      if (data.sdp) await pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch (e) {}
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

  function stop(message) {
    if (events) { events.close(); events = null; }
    if (pc) { pc.close(); pc = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('preview').srcObject = null;
    $('stage').classList.remove('on');
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && stream) keepAwake(); });
  if (!window.isSecureContext || !navigator.mediaDevices) status('Abra este link pelo navegador do celular (Safari ou Chrome) e aceite o aviso de segurança da rede local.', 'err');
})();`;
