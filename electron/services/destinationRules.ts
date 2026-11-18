/** Endereço RTMP/RTMPS sem espaços nem caracteres que confundam o FFmpeg. */
export const validServer = (server: string) => /^rtmps?:\/\/[^\s|[\]]{3,490}$/i.test(server);
/** Chave de transmissão: sem espaços nem separadores do FFmpeg. */
export const validKey = (key: string) => /^[^\s|[\]]{4,512}$/.test(key);
