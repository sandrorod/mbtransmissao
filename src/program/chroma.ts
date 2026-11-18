import type { ChromaKey } from '../types/studio';

const VERTEX = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2((p.x + 1.0) / 2.0, (1.0 - p.y) / 2.0); gl_Position = vec4(p, 0.0, 1.0); }`;
// Distância de cor em RGB: funciona para qualquer fundo (verde, azul, branco, preto…), não só tela verde.
const FRAGMENT = `precision mediump float;
uniform sampler2D tex; uniform vec3 key; uniform float similarity; uniform float smoothness; varying vec2 uv;
void main(){
  vec4 c = texture2D(tex, uv);
  float d = distance(c.rgb, key);
  float a = smoothstep(similarity, similarity + smoothness, d);
  gl_FragColor = vec4(c.rgb * a, a);
}`;

export const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Remove a cor de fundo na placa de vídeo (WebGL), quadro a quadro. */
export class ChromaKeyer {
  readonly canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext | null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  constructor() {
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true });
    const gl = this.gl;
    if (!gl) return;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    for (const name of ['key', 'similarity', 'smoothness']) this.uniforms[name] = gl.getUniformLocation(program, name);
  }

  /** Imagem com o fundo transparente (ou null se a placa de vídeo não estiver disponível). */
  process(source: TexImageSource, chroma: ChromaKey): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return null;
    const width = (source as HTMLVideoElement).videoWidth || (source as HTMLCanvasElement).width;
    const height = (source as HTMLVideoElement).videoHeight || (source as HTMLCanvasElement).height;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform3fv(this.uniforms.key, hexToRgb(chroma.color));
    gl.uniform1f(this.uniforms.similarity, chroma.similarity);
    gl.uniform1f(this.uniforms.smoothness, chroma.smoothness);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  dispose(): void {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
  }
}
