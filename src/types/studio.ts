/** Referência a um dispositivo do sistema: o id pode mudar entre sessões; o nome serve para reencontrar. */
export interface DeviceRef {
  deviceId: string;
  label: string;
}

export type DeviceKind = 'video' | 'audio';

/** Um modo de captura que a câmera realmente oferece (consultado no AVFoundation). */
export interface VideoMode {
  width: number;
  height: number;
  /** Taxas de quadros aceitas nesse tamanho, da maior para a menor. */
  fps: number[];
}

export const ASPECTS = ['original', '16:9', '4:3', '1:1', '9:16'] as const;
export type Aspect = (typeof ASPECTS)[number];
export const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];

export interface VideoSettings {
  /** 0 = deixar a câmera escolher. */
  width: number;
  height: number;
  fps: number;
  aspect: Aspect;
  rotation: Rotation;
  mirror: boolean;
  /** Parâmetros que a câmera expõe (zoom, brilho…); só aparecem os que ela suporta. */
  extra: Record<string, number>;
}

export const DEFAULT_VIDEO: VideoSettings = { width: 0, height: 0, fps: 0, aspect: 'original', rotation: 0, mirror: false, extra: {} };

export interface AudioSettings {
  /** 'all' = todos os canais; número = só aquele canal (0 = canal 1), em mono. */
  channel: 'all' | number;
  /** 0 = taxa do dispositivo. */
  sampleRate: number;
  stereo: boolean;
  /** Ganho de 0 a 2 (1 = sem alteração). */
  volume: number;
  muted: boolean;
  monitor: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** Corta graves abaixo de 80 Hz (vento, vibração, ronco de palco). */
  highPass: boolean;
}

export const DEFAULT_AUDIO: AudioSettings = {
  channel: 'all',
  sampleRate: 0,
  stereo: true,
  volume: 1,
  muted: false,
  monitor: false,
  noiseSuppression: false,
  echoCancellation: false,
  autoGainControl: false,
  highPass: false,
};

/** Fonte de cena: um dispositivo com as suas configurações. Uma fonte pode estar em várias cenas. */
export interface Source {
  id: string;
  kind: DeviceKind;
  name: string;
  device: DeviceRef;
  video?: VideoSettings;
  audio?: AudioSettings;
  /**
   * Ajustes feitos na Prévia (posição, tamanho, corte, tela cheia): vão junto quando a fonte entra no
   * Programa. null/ausente = nada ajustado ainda.
   */
  staged?: { transform: Transform | null; fill?: { before: Transform | null }; border?: Border | null };
}

export const BORDER_STYLES = {
  solida: 'Sólida',
  tracejada: 'Tracejada',
  pontilhada: 'Pontilhada',
  dupla: 'Dupla',
  neon: 'Neon (brilho)',
  sombra: 'Sombra',
} as const;
export type BorderStyle = keyof typeof BORDER_STYLES;

/** Borda em volta da fonte no Programa/Prévia. Medidas em pixels de uma tela 1080p (crescem/diminuem com a saída). */
export interface Border {
  style: BorderStyle;
  /** #rrggbb */
  color: string;
  /** Espessura (1 a 40). */
  width: number;
  /** Cantos arredondados (0 a 200; 0 = cantos retos). */
  radius: number;
}

export const DEFAULT_BORDER: Border = { style: 'solida', color: '#ffffff', width: 6, radius: 0 };

/**
 * Posição de uma fonte no programa, em frações da tela (0 a 1).
 * w = largura na tela; a altura sai da proporção da imagem já cortada (nunca distorce).
 * crop = quanto cortar de cada lado da imagem, em frações dela.
 */
export interface Transform {
  x: number;
  y: number;
  w: number;
  /** Altura própria (fração da tela): a imagem estica para caber (Tela cheia). Sem ela, segue a proporção. */
  h?: number;
  crop: { l: number; t: number; r: number; b: number };
}

export const NO_CROP = { l: 0, t: 0, r: 0, b: 0 };

/** Fonte dentro de uma cena; a mesma fonte pode estar em várias cenas com posições diferentes. */
export interface SceneItem {
  sourceId: string;
  /** null = encaixada na tela inteira. */
  transform: Transform | null;
  hidden: boolean;
  /** Pasta onde a fonte está na lista (só organização; as fontes da pasta ficam juntas nas camadas). */
  folder?: string | null;
  /** Cadeado: no Programa a fonte não pode ser movida, redimensionada nem cortada. */
  locked?: boolean;
  /** Botão "Tela cheia" do Programa: guarda a posição de antes para o "Voltar". */
  fill?: { before: Transform | null };
  /** Borda em volta da fonte (null/ausente = sem borda). */
  border?: Border | null;
}

/** Pasta das fontes do programa. */
export interface SceneFolder {
  id: string;
  name: string;
  collapsed: boolean;
  /** Cadeado da pasta: trava todas as fontes dela no Programa. */
  locked?: boolean;
}

export interface Scene {
  id: string;
  name: string;
  /** Da camada de trás (primeira) para a da frente (última). */
  items: SceneItem[];
  folders?: SceneFolder[];
}

/** Remover uma cor de fundo (chroma key). */
export interface ChromaKey {
  enabled: boolean;
  /** Cor a remover, em #rrggbb. */
  color: string;
  /** Quão parecida com a cor um pixel precisa ser para sumir (0 a 1). */
  similarity: number;
  /** Transição suave na borda (0 a 1). */
  smoothness: number;
}

export const DEFAULT_CHROMA: ChromaKey = { enabled: false, color: '#00ff00', similarity: 0.25, smoothness: 0.08 };

/** Widget: página da web exibida como fonte de vídeo (placar de outro site, gráfico, etc.). */
export interface WebPage {
  id: string;
  name: string;
  url: string;
  /** Tamanho da janela em que a página é desenhada. */
  width: number;
  height: number;
  /** Só esta parte da página aparece (frações); null = página inteira. */
  region: { x: number; y: number; w: number; h: number } | null;
  chroma: ChromaKey;
  /** Até onde a página foi rolada (ponto onde rolou, em px da página, e posição de rolagem resultante). */
  scroll?: PageScroll | null;
  /** Widget com som: o áudio da página vira canal no mixer e vai para a transmissão. */
  audio?: boolean;
  /** Pasta do widget na lista de widgets (só organização). */
  folder?: string | null;
}

/** Foto ou vídeo do computador para exibir na transmissão (fica copiado na pasta do app). */
export interface MediaFile {
  id: string;
  name: string;
  ext: string;
  kind: 'imagem' | 'video';
}

export interface MediaItem extends MediaFile {
  /** Vídeo: recomeça sozinho ao terminar. */
  loop: boolean;
  /** Vídeo: o som vai para o mixer (e para a transmissão). */
  audio: boolean;
}

export const MEDIA_SCHEME = 'estudio-midia';
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'] as const;
export const mediaUrl = (m: Pick<MediaFile, 'id' | 'ext'>) => `${MEDIA_SCHEME}://arquivo/${m.id}.${m.ext}`;

export interface PageScroll {
  x: number;
  y: number;
  top: number;
  left: number;
}

/** Papéis escolhidos para a transmissão. */
export const ROLES = {
  camera: { label: 'Câmera', kind: 'video' },
  secondaryCamera: { label: 'Câmera secundária', kind: 'video' },
  microphone: { label: 'Microfone', kind: 'audio' },
  auxAudio: { label: 'Áudio auxiliar', kind: 'audio' },
} as const;
export type Role = keyof typeof ROLES;

export interface Project {
  version: 1;
  name: string;
  sources: Source[];
  scenes: Scene[];
  activeSceneId: string | null;
  roles: Partial<Record<Role, DeviceRef>>;
  /** Saída onde o operador ouve o monitoramento. */
  monitorOutput: DeviceRef | null;
  pages: WebPage[];
  /** Fotos e vídeos importados ("midia:<id>" nas fontes). */
  media?: MediaItem[];
  /** Elementos na Prévia (ids de dispositivo, na ordem das camadas). */
  preview?: string[];
  /** Pastas da lista de widgets. */
  widgetFolders?: SceneFolder[];
}

/** Preferências do computador (valem para qualquer projeto). */
export interface Preferences {
  camera: DeviceRef | null;
  microphone: DeviceRef | null;
  audioInterface: DeviceRef | null;
  monitorOutput: DeviceRef | null;
  /** Dispositivos que o operador tirou da lista (nome normalizado). */
  hidden: string[];
  /** Câmeras e celulares com o replay desligado (nome normalizado): continuam na lista e na imagem, mas não gravam replay. */
  replayOff: string[];
  /** Programa em cima da prévia (arrastando um sobre o outro troca). */
  programFirst: boolean;
  /** Painel "Seleção para a transmissão" aberto. */
  selectionOpen: boolean;
  output: OutputSettings;
  /** Endereço público para os celulares (quando houver um domínio); vazio = rede Wi‑Fi local. */
  publicAddress: string;
  /** Servidor TURN para o vídeo dos celulares atravessar redes restritas (4G); null = só STUN. */
  turn: TurnServer | null;
  /** Nomes dados aos dispositivos pelo operador (chave: nome normalizado do aparelho). */
  names: Record<string, string>;
  /** Onde fica cada área da tela e o tamanho dela. */
  layout: Layout;
  /** Indicadores ligados na barra do programa (conexão, pessoas online, comentários). */
  hud: ProgramHud;
  /** Duração do replay (⌘R / Ctrl+R durante a transmissão), em segundos. */
  replaySeconds: number;
  /** Vinheta de entrada: passa antes dos replays (o arquivo fica na pasta do app). */
  replayIntro: ReplayIntro | null;
  /** Vinheta de saída: passa depois do último replay, antes de voltar para a cena. */
  replayOutro: ReplayIntro | null;
  /** Efeito entre a abertura e os replays (e entre um replay e outro). */
  replayTransition: ReplayTransition;
}

/** Velocidades do replay oferecidas na tela (1 = normal). Não fica salva: o Estúdio sempre abre em 1x. */
export const REPLAY_SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;

/** Qual vinheta do replay: a de entrada (abertura) ou a de saída. */
export type VignetteKind = 'entrada' | 'saida';

/** Vinheta do replay (entrada ou saída). */
export interface ReplayIntro {
  /** Nome do arquivo importado (só para mostrar). */
  name: string;
  /** Extensão do arquivo guardado (mp4, mov, webm, m4v). */
  ext: string;
  /** Corte do começo: a vinheta começa neste segundo do vídeo. */
  start: number;
  /** Corte do fim: a vinheta termina neste segundo do vídeo; 0 = até o fim. */
  end: number;
  /** O som da abertura vai para a transmissão. */
  sound: boolean;
  /** Remover o fundo da abertura: onde ele some, aparece a imagem do Programa. */
  chroma: ChromaKey;
}

export const TRANSITIONS = {
  fade: 'Fusão (uma imagem some na outra)',
  preto: 'Passagem pelo preto',
  deslizar: 'Deslizar para o lado',
  corte: 'Corte seco (sem efeito)',
} as const;
export type TransitionKind = keyof typeof TRANSITIONS;

export interface ReplayTransition {
  kind: TransitionKind;
  /** Duração do efeito, em ms. */
  ms: number;
}

export const DEFAULT_TRANSITION: ReplayTransition = { kind: 'fade', ms: 600 };
export const INTRO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'] as const;

export const REPLAY_MIN = 7;
export const REPLAY_MAX = 30;
export const DEFAULT_REPLAY_SECONDS = 15;

/** Corte dos últimos segundos da transmissão. */
export interface ReplayClip {
  /** Nome do arquivo (replay-<data em ms>-<segundos>s.mp4). */
  id: string;
  createdAt: number;
  seconds: number;
  bytes: number;
  /** Câmera de onde veio o corte (sem = o Programa, o que foi ao ar). */
  source?: string;
  /** Nome dado pelo operador (vazio = "Replay N"). */
  name?: string;
  /** Pasta na área Replay (null = fora de pasta). */
  folder?: string | null;
  /** Observação livre (lance, jogador…). */
  note?: string;
  /** Corte do replay, em segundos do vídeo: começa em `start` e para em `end` (null = até o fim). */
  start?: number;
  end?: number | null;
}

/** O que o operador pode mudar num replay. */
export type ReplayPatch = Partial<Pick<ReplayClip, 'name' | 'folder' | 'note' | 'start' | 'end'>>;

export interface ReplayFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

/** Áreas que o operador pode arrastar e redimensionar (o Programa fica sempre no centro). */
export const PANEL_IDS = ['dispositivos', 'widgets', 'midias', 'previa', 'cenas', 'mixer', 'selecao', 'replay'] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export type ZoneId = 'left' | 'bottom';
/** Áreas que ocupam a largura toda da faixa, acima ou abaixo das colunas lado a lado. */
export interface ZoneSpans {
  top: PanelId[];
  bottom: PanelId[];
}
/** Coluna de uma faixa: uma área, ou várias empilhadas (de cima para baixo). */
export type PanelColumn = PanelId[];

export interface Layout {
  /**
   * Coluna da esquerda: "dispositivos" sempre primeiro, sozinho na largura toda; as outras ficam
   * lado a lado embaixo dele (uma só = largura toda).
   */
  left: PanelColumn[];
  /** Linha embaixo do Programa (colunas da esquerda para a direita; cada coluna pode ter áreas empilhadas). */
  bottom: PanelColumn[];
  /** Fração de cada coluna na sua faixa (mesma ordem; na esquerda, sem "dispositivos"); null = automático. */
  leftSizes: number[] | null;
  /** Altura de "dispositivos" na coluna da esquerda (fração), quando há áreas embaixo dele. */
  devicesHeight: number;
  bottomSizes: number[] | null;
  /** Largura da coluna da esquerda e altura da linha de baixo, em pixels. */
  leftWidth: number;
  bottomHeight: number;
  /** Altura de cada área numa coluna empilhada (chave: ids da coluna unidos por "+"); sem chave = partes iguais. */
  stackSizes: Record<string, number[]>;
  /** Áreas fechadas pelo X (reabrem pelo menu Exibição no lugar onde estavam). */
  closed: ClosedPanel[];
  /** Áreas na largura toda de cada faixa (acima/abaixo das colunas). */
  spans: Record<ZoneId, ZoneSpans>;
  /** Altura de cada linha da faixa quando há áreas na largura toda (chave = faixa). */
  spanSizes: Partial<Record<ZoneId, number[]>>;
}

export interface ClosedPanel {
  id: PanelId;
  zone: ZoneId;
  /** Coluna onde estava. */
  index: number;
  /** Posição na pilha da coluna; null = estava sozinha numa coluna. */
  row: number | null;
  /** Estava na largura toda da faixa (acima ou abaixo das colunas). */
  span?: 'top' | 'bottom';
}

export const DEFAULT_LAYOUT: Layout = {
  left: [['dispositivos'], ['widgets'], ['midias'], ['replay']],
  bottom: [['previa'], ['cenas'], ['mixer'], ['selecao']],
  leftSizes: null,
  devicesHeight: 0.62,
  bottomSizes: null,
  leftWidth: 380,
  bottomHeight: 320,
  stackSizes: {},
  closed: [],
  spans: { left: { top: [], bottom: [] }, bottom: { top: [], bottom: [] } },
  spanSizes: {},
};

export interface OutputSettings {
  width: number;
  height: number;
  fps: number;
  /** Kbps do vídeo enviado às plataformas. */
  bitrate: number;
  encoder: 'hardware' | 'x264';
}

export const OUTPUT_PRESETS = [
  { label: '1080p · 30 fps (recomendado)', width: 1920, height: 1080, fps: 30, bitrate: 8000 },
  { label: '1080p · 60 fps (pesado: exige Mac forte)', width: 1920, height: 1080, fps: 60, bitrate: 9000 },
  { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 4000 },
  { label: '720p · 60 fps (pesado)', width: 1280, height: 720, fps: 60, bitrate: 6000 },
] as const;

/**
 * Melhor qualidade que já vem marcada: 1080p a 30 quadros com 8 Mbps (faixa recomendada pelo YouTube para
 * 1080p30). 60 quadros dobra o trabalho do Mac e, num Mac Intel, faz a live travar mais do que melhora.
 */
export const DEFAULT_OUTPUT: OutputSettings = { width: 1920, height: 1080, fps: 30, bitrate: 8000, encoder: 'hardware' };
/** Padrão antigo: quem ainda está nele passa para o novo (não mexe em quem escolheu outra coisa). */
export const OLD_DEFAULT_BITRATE = 6000;

export const EMPTY_PREFERENCES: Preferences = {
  camera: null,
  microphone: null,
  audioInterface: null,
  monitorOutput: null,
  hidden: [],
  replayOff: [],
  programFirst: false,
  selectionOpen: false,
  output: DEFAULT_OUTPUT,
  publicAddress: '',
  turn: null,
  names: {},
  layout: DEFAULT_LAYOUT,
  hud: { quality: true, viewers: true, chat: false },
  replaySeconds: 15,
  replayIntro: null,
  replayOutro: null,
  replayTransition: DEFAULT_TRANSITION,
};

/** Plataformas com o servidor já preenchido; a chave é sempre do operador. */
export const PLATFORMS = {
  youtube: { label: 'YouTube', server: 'rtmps://a.rtmps.youtube.com:443/live2' },
  facebook: { label: 'Facebook', server: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
  instagram: { label: 'Instagram', server: '' },
  twitch: { label: 'Twitch', server: 'rtmp://live.twitch.tv/app' },
  kick: { label: 'Kick', server: '' },
  tiktok: { label: 'TikTok', server: '' },
  custom: { label: 'Outro (RTMP/RTMPS)', server: '' },
} as const;
export type Platform = keyof typeof PLATFORMS;

/** Destino como a interface vê: a chave nunca vem junto, só os 4 últimos caracteres. */
export interface Destination {
  id: string;
  platform: Platform;
  name: string;
  server: string;
  keyHint: string;
  enabled: boolean;
}

export interface DestinationInput {
  id?: string;
  platform: Platform;
  name: string;
  server: string;
  /** Vazio ao editar = manter a chave que já está guardada. */
  key: string;
  enabled: boolean;
}

export type LiveState = 'parado' | 'iniciando' | 'ao-vivo' | 'reconectando' | 'erro';

export interface LiveStatus {
  state: LiveState;
  startedAt: number | null;
  fps: number;
  kbps: number;
  /** Mensagem já sem chaves. */
  message: string | null;
  destinations: { id: string; name: string; ok: boolean; error: string | null }[];
  /** Velocidade do envio (1 = tempo real; abaixo de ~0,95 a internet ou o computador não acompanham). */
  speed?: number;
}

export type SyncState = 'sincronizado' | 'pendente' | 'enviando' | 'sem-internet' | 'erro';

export interface AccountView {
  /** O app tem servidor de contas configurado. */
  configured: boolean;
  /** Teste automático/cópia de dados: sem login. */
  local: boolean;
  user: { email: string; offline: boolean } | null;
  sync: { state: SyncState; message: string | null };
}

/** Mensagem do chat ao vivo do YouTube. */
export interface LiveChatMessage {
  id: string;
  author: string;
  avatar: string | null;
  text: string;
  /** ISO 8601. */
  at: string;
  role: 'dono' | 'moderador' | null;
  /** Super Chat (valor já formatado pelo YouTube). */
  amount: string | null;
}

/** O que o YouTube informa da live enquanto ela acontece (para o painel do operador, nunca vai ao ar). */
export interface LiveExtras {
  /** Sem conta do YouTube conectada ou sem live escolhida. */
  available: boolean;
  title: string | null;
  /** Situação da live no YouTube (ready, testing, live, complete…). */
  status: string | null;
  viewers: number | null;
  /** Curtidas da live (null = o YouTube não informou). */
  likes: number | null;
  /** Sinal recebido pelo YouTube: good, ok, bad, noData. */
  health: string | null;
  issues: string[];
  chat: LiveChatMessage[];
  chatError: string | null;
  error: string | null;
}

/** Indicadores ligados na barra do programa. */
export interface ProgramHud {
  quality: boolean;
  viewers: boolean;
  chat: boolean;
}

export const DEFAULT_HUD: ProgramHud = { quality: true, viewers: true, chat: false };

export interface YoutubeState {
  /** Canal na lista de canais do Estúdio. */
  id: string;
  /** ID e chave secreta do cliente OAuth já informados. */
  configured: boolean;
  /** Conta autorizada (há acesso guardado no Keychain). */
  connected: boolean;
  channel: { id: string; title: string; thumbnail: string | null } | null;
  clientId: string;
}

/** Destino que o Estúdio mantém para a live escolhida em cada canal do YouTube. */
export const youtubeDestinationId = (accountId: string) => (accountId === 'principal' ? 'youtube-conta' : `youtube-conta:${accountId}`);
export const isYoutubeDestination = (destinationId: string) => destinationId === 'youtube-conta' || destinationId.startsWith('youtube-conta:');
export const accountOfDestination = (destinationId: string) => (destinationId === 'youtube-conta' ? 'principal' : destinationId.startsWith('youtube-conta:') ? destinationId.slice('youtube-conta:'.length) : null);

/** Google Drive (Configurações › Google Drive): onde os replays marcados são guardados. */
export interface DriveState {
  configured: boolean;
  connected: boolean;
  email: string | null;
  clientId: string;
  folderName: string;
  /** Cada replay cortado vai sozinho para o Drive. */
  auto: boolean;
}

/** Vídeo na pasta do projeto no Drive (página dos replays). */
export interface DriveVideo {
  id: string;
  name: string;
  bytes: number;
  createdAt: number;
  seconds: number | null;
}

/** Pasta do projeto no Drive: vídeos soltos (name null) e os de cada subpasta. */
export interface DriveListing {
  project: string;
  url: string;
  groups: { name: string | null; videos: DriveVideo[] }[];
}

export interface DriveUploadResult {
  name: string;
  ok: boolean;
  link: string | null;
  error: string | null;
}

/** Resultado de importar um arquivo de chaves. */
export interface KeysImportResult {
  channels: number;
  destinations: number;
}

export interface YoutubeBroadcast {
  id: string;
  title: string;
  description: string;
  scheduledStart: string | null;
  /** created, ready, testing, live, complete… (lifeCycleStatus do YouTube). */
  status: string;
  privacy: 'public' | 'unlisted' | 'private';
  thumbnail: string | null;
  url: string;
}

export interface YoutubeNewBroadcast {
  title: string;
  description: string;
  /** ISO 8601. */
  scheduledStart: string;
  privacy: 'public' | 'unlisted' | 'private';
}

/** Celular conectado pelo link/QR. */
export interface PhoneInfo {
  id: string;
  name: string;
}

/** Servidor TURN (Metered, Cloudflare, coturn…): endereços turn:/turns: separados por vírgula. */
export interface TurnServer {
  urls: string;
  username: string;
  credential: string;
}

/** Túnel para celulares de outra rede. */
export interface RemoteState {
  state: 'desligado' | 'preparando' | 'ligado' | 'erro';
  url: string | null;
  message: string | null;
}

/** Transmissão: configuração do projeto + os replays dela. */
export interface SessionInfo {
  id: string;
  name: string;
  createdAt: number;
}

export interface SessionSummary extends SessionInfo {
  /** Quando foi guardada (ao começar outra ou recuperar uma anterior). */
  archivedAt: number;
  replays: number;
  bytes: number;
}

export interface ReplayGalleryLink {
  urls: string[];
  running: boolean;
  error: string | null;
}

export interface PhoneLink {
  /** Endereços da rede local (o operador escolhe se houver mais de um). */
  urls: string[];
  publicUrl: string | null;
  /** Celulares de outra rede (túnel ligado pelo operador). */
  remote: RemoteState;
  port: number;
  running: boolean;
  error: string | null;
}

/** Mensagens entre o processo principal e a tela sobre os celulares. */
export type PhoneEvent =
  | { t: 'entrou'; id: string; nome: string }
  | { t: 'saiu'; id: string }
  | { t: 'nome'; id: string; nome: string }
  | { t: 'sinal'; id: string; dados: unknown };

export type AccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface MediaAccess {
  camera: AccessStatus;
  microphone: AccessStatus;
  screen: AccessStatus;
}

/** Dispositivos vistos pelo AVFoundation (via FFmpeg), para conferir a lista e consultar modos. */
export interface NativeDevices {
  video: string[];
  audio: string[];
}

/** Arquivo de layout (Menu › Layout): a disposição das áreas, os indicadores do Programa e a janela. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
}

export interface LayoutFile {
  kind: 'estudio-layout';
  version: 1;
  layout: Layout;
  hud: ProgramHud;
  window: WindowState | null;
}

export interface StudioApi {
  mediaAccess(): Promise<MediaAccess>;
  requestAccess(kind: 'camera' | 'microphone'): Promise<boolean>;
  openPrivacySettings(kind: 'camera' | 'microphone' | 'screen'): Promise<void>;
  /**
   * Apaga a decisão do macOS sobre câmera e microfone só deste app e reabre o app: o macOS pergunta de novo.
   * Conserta a permissão "presa" de uma versão anterior (lista de aparelhos sem resposta).
   */
  resetMediaPermissions(): Promise<void>;
  /** Põe/tira a janela do app da tela cheia do sistema (monitor inteiro). */
  setFullScreen(on: boolean): Promise<void>;
  /** Avisa quando a janela entra/sai da tela cheia (pelo app, pelo menu ou pelo botão verde do macOS). */
  onFullScreen(cb: (on: boolean) => void): () => void;
  listNativeDevices(): Promise<NativeDevices>;
  probeVideoModes(label: string): Promise<VideoMode[] | null>;
  /** Esquece os modos já consultados (um aparelho novo com o mesmo nome pode ser outro). */
  forgetVideoModes(): Promise<void>;
  loadProject(): Promise<Project | null>;
  saveProject(project: Project): Promise<void>;
  openProjectFile(): Promise<Project | null>;
  saveProjectFileAs(project: Project): Promise<string | null>;
  /** Salva o layout atual (mais o tamanho/posição da janela) num arquivo; null = cancelado. */
  saveLayoutFile(data: { layout: Layout; hud: ProgramHud }): Promise<string | null>;
  /** Abre um arquivo de layout: a janela volta ao tamanho salvo e a disposição volta para a tela; null = cancelado. */
  openLayoutFile(): Promise<{ layout: Layout; hud: ProgramHud; path: string } | null>;
  loadPreferences(): Promise<Preferences>;
  savePreferences(preferences: Preferences): Promise<void>;
  /** 'dispositivos' = autoteste com os aparelhos reais; 'e2e' = celular simulado, página e transmissão local. */
  selfTestMode(): Promise<string | null>;
  reportSelfTest(report: unknown): Promise<void>;

  phoneLink(): Promise<PhoneLink>;
  newPhoneLink(): Promise<PhoneLink>;
  /** Liga/desliga o endereço público para celulares de outra rede. */
  setPhoneRemote(on: boolean): Promise<PhoneLink>;
  /** STUN/TURN usados na conexão com os celulares. */
  phoneIce(): Promise<RTCIceServer[]>;
  /** Mudou o estado do endereço público (preparando → ligado, caiu…). */
  onPhoneRemote(cb: (link: PhoneLink) => void): () => void;
  /** A tela está pronta para receber celulares (pede a cada um que envie o vídeo). */
  phonesReady(): Promise<PhoneInfo[]>;
  sendToPhone(id: string, message: unknown): Promise<void>;
  removePhone(id: string): Promise<void>;
  onPhoneEvent(cb: (event: PhoneEvent) => void): () => void;

  /** Abre (ou atualiza) a janela escondida da página e devolve o id para capturá-la. */
  openPage(page: WebPage): Promise<string>;
  reloadPage(id: string): Promise<void>;
  /** Rola a página do widget no ponto (x, y) e devolve a posição de rolagem resultante. */
  scrollPage(id: string, x: number, y: number, dx: number, dy: number): Promise<PageScroll | null>;
  closePage(id: string): Promise<void>;

  listDestinations(): Promise<Destination[]>;
  saveDestination(input: DestinationInput): Promise<Destination[]>;
  deleteDestination(id: string): Promise<Destination[]>;
  /** Abre a transmissão e devolve o número da sessão (os pedaços de outra sessão são descartados). */
  startLive(output: OutputSettings, mimeType: string): Promise<number>;
  sendLiveChunk(session: number, chunk: ArrayBuffer): void;
  /** Linha no registro da transmissão (diagnóstico). */
  liveLog(line: string): void;
  /** Conta do usuário: quem está logado e a situação da sincronização com a nuvem. */
  accountState(): Promise<AccountView>;
  accountLogin(email: string, password: string, create: boolean): Promise<AccountView>;
  accountLogout(): Promise<AccountView>;
  accountSyncNow(): Promise<AccountView>;
  onAccountSync(cb: (sync: AccountView['sync']) => void): () => void;
  /** endBroadcast: também encerra a live no YouTube (sem isso ela continua aberta para voltar depois). */
  stopLive(endBroadcast?: boolean): Promise<void>;
  onLiveStatus(cb: (status: LiveStatus) => void): () => void;
  /** Registro da última transmissão (sem chaves). */
  readLiveLog(): Promise<string>;

  /** Canais do YouTube conectados (cada um com o próprio login). */
  youtubeAccounts(): Promise<YoutubeState[]>;
  /** Canal novo (usa o mesmo cliente OAuth do primeiro canal; é só entrar com a outra conta). */
  youtubeAdd(): Promise<YoutubeState[]>;
  /** Tira o canal do Estúdio (e o destino dele). */
  youtubeRemove(id: string): Promise<{ accounts: YoutubeState[]; destinations: Destination[] }>;
  youtubeState(id: string): Promise<YoutubeState>;
  youtubeSetClient(id: string, clientId: string, clientSecret: string): Promise<YoutubeState>;
  youtubeConnect(id: string): Promise<YoutubeState>;
  youtubeCancel(): Promise<void>;
  youtubeDisconnect(id: string): Promise<YoutubeState>;
  youtubeBroadcasts(id: string): Promise<YoutubeBroadcast[]>;
  youtubeCreate(id: string, input: YoutubeNewBroadcast): Promise<YoutubeBroadcast>;
  /** Liga a live escolhida do canal ao Estúdio e a deixa como destino ativo (a chave não vem para a tela). */
  youtubeUse(id: string, broadcastId: string): Promise<Destination[]>;
  driveState(): Promise<DriveState>;
  driveSetClient(clientId: string, clientSecret: string): Promise<DriveState>;
  /** Usa o mesmo cliente OAuth já cadastrado no primeiro canal do YouTube. */
  driveUseYoutubeClient(): Promise<DriveState>;
  driveConnect(): Promise<DriveState>;
  driveCancel(): Promise<void>;
  driveDisconnect(): Promise<DriveState>;
  driveSetFolder(name: string): Promise<DriveState>;
  /** Envia os replays (id + nome que aparece na lista) para a pasta do Estúdio no Drive. */
  /** folder = nome da pasta do replay no Estúdio: vira uma pasta com o mesmo nome dentro da pasta do Drive. */
  driveUpload(items: { id: string; name: string; folder?: string | null }[]): Promise<DriveUploadResult[]>;
  onDriveProgress(cb: (p: { done: number; total: number; name: string }) => void): () => void;
  /** Abre no navegador a pasta do projeto no Google Drive. */
  driveOpenFolder(): Promise<void>;
  /** Liga/desliga o envio automático de cada replay cortado. */
  driveSetAuto(on: boolean): Promise<DriveState>;
  /** Pasta do projeto no Drive (cria se faltar) e o link dela; share = qualquer pessoa com o link pode ver. */
  driveProjectFolder(share?: boolean): Promise<{ url: string; shared: boolean; project: string }>;
  /** Terminou um envio automático (depois de um corte). */
  onDriveAutoDone(cb: (r: { sent: number; total: number; project: string; error: string | null }) => void): () => void;
  /** Transmissão atual. */
  sessionCurrent(): Promise<SessionInfo>;
  /** Transmissões guardadas (anteriores). */
  sessionList(): Promise<SessionSummary[]>;
  /** Guarda a atual (projeto + replays) e começa outra com a mesma configuração, sem replays. */
  sessionNew(name: string, project: Project): Promise<SessionInfo>;
  /** Guarda a atual e traz de volta a escolhida: devolve o projeto dela (os replays voltam para a área Replay). */
  sessionRestore(id: string, project: Project): Promise<{ info: SessionInfo; project: Project }>;
  sessionRemove(id: string): Promise<SessionSummary[]>;
  /** Endereços da página dos replays na rede Wi‑Fi (link secreto). */
  replayGalleryLink(): Promise<ReplayGalleryLink>;
  /** Troca o link secreto da página dos replays (o antigo para de funcionar). */
  replayGalleryNewLink(): Promise<ReplayGalleryLink>;
  /** Baixa as chaves (canais e destinos) num arquivo protegido por senha; null = cancelado. */
  keysExport(password: string): Promise<{ path: string; channels: number; destinations: number } | null>;
  /** Escolhe o arquivo de chaves a importar (devolve o nome; null = cancelado). */
  keysPick(): Promise<string | null>;
  /** Abre o arquivo escolhido com a senha e junta os canais e destinos aos daqui. */
  keysImport(password: string): Promise<KeysImportResult>;
  /** Liga/desliga a leitura de pessoas online, saúde do sinal e chat da live do YouTube. */
  watchLiveExtras(opts: { stats: boolean; chat: boolean }): Promise<void>;
  onLiveExtras(cb: (extras: LiveExtras) => void): () => void;

  /** Corta os últimos `seconds` segundos do Programa e de cada câmera gravando (só durante a live). */
  replayCut(seconds: number): Promise<ReplayClip[]>;
  /** Começa a guardar os últimos segundos de uma câmera (vídeo gravado na tela, enviado em pedaços). */
  replayCamStart(key: string, label: string, mimeType: string): Promise<void>;
  replayCamChunk(key: string, chunk: ArrayBuffer): void;
  replayCamStop(key: string): Promise<void>;
  replayList(): Promise<ReplayClip[]>;
  /** Bytes do vídeo (MP4) para tocar no programa. */
  replayRead(id: string): Promise<Uint8Array>;
  replayDelete(id: string): Promise<ReplayClip[]>;
  replayReveal(id: string): Promise<void>;
  /** Copia texto pela área de transferência do sistema (a do navegador falha na janela do app). */
  copyText(text: string): Promise<void>;
  /** Abre um endereço https no navegador do sistema. */
  openExternal(url: string): Promise<void>;
  /** Muda nome, pasta, observação ou corte do replay. */
  replayUpdate(id: string, patch: ReplayPatch): Promise<ReplayClip[]>;
  replayFolders(): Promise<ReplayFolder[]>;
  replaySaveFolders(folders: ReplayFolder[]): Promise<ReplayFolder[]>;
  /** Escolhe e importa o vídeo de abertura (null = cancelou). */
  replayIntroPick(which: VignetteKind): Promise<{ name: string; ext: string } | null>;
  replayIntroRead(which: VignetteKind, ext: string): Promise<Uint8Array>;
  replayIntroClear(which: VignetteKind): Promise<void>;
  /** Escolhe fotos/vídeos no computador e copia para a pasta do app. */
  mediaPick(): Promise<MediaFile[]>;
  mediaRemove(id: string, ext: string): Promise<void>;
}
