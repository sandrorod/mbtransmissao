import { createServer, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface Tunnel {
  /** Endereço rtmp:// local que leva, criptografado, até o destino rtmps://. */
  url: string;
  close: () => void;
}

/**
 * Túnel TLS para RTMPS. O FFmpeg embutido usa a criptografia antiga do macOS (SecureTransport), que cai
 * com "IO Error -9806" poucos quadros depois que o YouTube aceita a chave. Aqui o FFmpeg fala RTMP com
 * 127.0.0.1 e o próprio app faz a conexão TLS (OpenSSL do Node) até o servidor: na internet continua
 * tudo criptografado.
 */
export async function openTlsTunnel(rtmpsUrl: string, log: (line: string) => void = () => undefined): Promise<Tunnel> {
  const target = new URL(rtmpsUrl);
  const host = target.hostname;
  const port = Number(target.port || 443);
  const sockets = new Set<Socket>();
  const server = createServer((local) => {
    const remote = tlsConnect({ host, port, servername: host });
    sockets.add(local);
    sockets.add(remote);
    remote.setNoDelay(true);
    local.setNoDelay(true);
    remote.once('secureConnect', () => log(`túnel TLS conectado a ${host}:${port} (${remote.getProtocol() ?? 'TLS'})`));
    local.pipe(remote);
    remote.pipe(local);
    const end = (who: string) => (error?: Error) => {
      if (error) log(`túnel TLS (${who}): ${error.message}`);
      local.destroy();
      remote.destroy();
      sockets.delete(local);
      sockets.delete(remote);
    };
    local.on('error', end('local'));
    remote.on('error', end(host));
    local.on('close', () => end('local')());
    remote.on('close', () => end(host)());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const localPort = (server.address() as { port: number }).port;
  return {
    url: `rtmp://127.0.0.1:${localPort}${target.pathname}${target.search}`,
    close: () => {
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}
