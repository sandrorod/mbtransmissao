import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO, type VideoSettings } from '../types/studio';
import { centerTransform, contentZoom, fillTransform, stretchTransform, snapToCenterY, panRegion, setContentZoom, snapToCenterX, placement, sourceRect, toTransform, visibleArea, zoomRegion } from './compositor';

const frame = { w: 1920, h: 1080 };
const canvas = { w: 1920, h: 1080 };
const settings = (patch: Partial<VideoSettings>): VideoSettings => ({ ...DEFAULT_VIDEO, ...patch });

describe('compositor', () => {
  it('sem posição salva, encaixa a imagem inteira sem distorcer', () => {
    const area = visibleArea({ w: 640, h: 480 }, undefined);
    const rect = placement(area, null, canvas);
    expect(rect.h).toBe(1080);
    expect(rect.w).toBeCloseTo(1440);
    expect(rect.x).toBeCloseTo(240);
  });

  it('corte reduz a área e mantém a escala', () => {
    const area = visibleArea(frame, undefined, { l: 0.25, t: 0, r: 0.25, b: 0.5 });
    expect(area).toEqual({ x: 480, y: 0, w: 960, h: 540 });
    const rect = placement(area, { x: 0.1, y: 0.2, w: 0.5, crop: { l: 0.25, t: 0, r: 0.25, b: 0.5 } }, canvas);
    expect(rect).toEqual({ x: 192, y: 216, w: 960, h: 540 });
  });

  it('proporção escolhida corta no centro antes do corte manual', () => {
    expect(visibleArea(frame, settings({ aspect: '1:1' }))).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
  });

  it('girar 90°: a imagem fica em pé e o recorte volta ao quadro original', () => {
    const s = settings({ rotation: 90 });
    const area = visibleArea(frame, s);
    expect([area.w, area.h]).toEqual([1080, 1920]);
    // Girando no sentido horário, o lado direito do quadro original vai para baixo:
    // cortar o topo da imagem em pé deixa só a metade direita do original.
    const cropped = visibleArea(frame, s, { l: 0, t: 0.5, r: 0, b: 0 });
    const src = sourceRect(frame, cropped, s);
    expect(src.w).toBeCloseTo(960);
    expect(src.h).toBeCloseTo(1080);
    expect(src.x).toBeCloseTo(960);
  });

  it('espelhar: cortar a esquerda da tela corta a direita do quadro original', () => {
    const s = settings({ mirror: true });
    const area = visibleArea(frame, s, { l: 0.5, t: 0, r: 0, b: 0 });
    expect(sourceRect(frame, area, s).x).toBeCloseTo(0);
    expect(sourceRect(frame, area, undefined).x).toBeCloseTo(960);
  });

  it('preencher a tela corta o excesso no centro', () => {
    const t = fillTransform({ w: 640, h: 480 }, undefined, canvas);
    expect(t.crop.t).toBeCloseTo(0.125);
    expect(t.crop.b).toBeCloseTo(0.125);
    const rect = placement(visibleArea({ w: 640, h: 480 }, undefined, t.crop), t, canvas);
    expect(rect.w).toBeCloseTo(1920);
    expect(rect.h).toBeCloseTo(1080);
  });

  it('converter a posição encaixada em posição salva não move nada', () => {
    const area = visibleArea({ w: 640, h: 480 }, undefined);
    const rect = placement(area, null, canvas);
    const again = placement(area, toTransform(rect, canvas), canvas);
    expect(again.x).toBeCloseTo(rect.x);
    expect(again.w).toBeCloseTo(rect.w);
    expect(again.h).toBeCloseTo(rect.h);
  });

  it('widget: só a área escolhida da página aparece, e o corte manual vale dentro dela', () => {
    const region = { x: 0.5, y: 0.25, w: 0.25, h: 0.5 };
    expect(visibleArea(frame, undefined, undefined, region)).toEqual({ x: 960, y: 270, w: 480, h: 540 });
    expect(visibleArea(frame, undefined, { l: 0.5, t: 0, r: 0, b: 0 }, region)).toEqual({ x: 1200, y: 270, w: 240, h: 540 });
  });

  it('widget: Preencher cobre a tela inteira usando só a área escolhida da página', () => {
    const canvas = { w: 1920, h: 1080 };
    const frame = { w: 1280, h: 720 };
    const region = { x: 0.38, y: 0.18, w: 0.3, h: 0.17 };
    const t = fillTransform(frame, undefined, canvas, region);
    const rect = placement(visibleArea(frame, undefined, t.crop, region), t, canvas);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
    expect(rect.w).toBeCloseTo(1920);
    expect(rect.h).toBeCloseTo(1080, 0);
  });

  it('widget: arrastar o conteúdo move a página ao contrário, na mesma escala da tela, sem sair da página', () => {
    const region = { x: 0.4, y: 0.2, w: 0.25, h: 0.25 };
    const shown = { x: 0, y: 0, w: 500, h: 500 };
    // Arrastar 100 px para a direita (1/5 da moldura) mostra 1/5 da área mais à esquerda.
    const r = panRegion(region, undefined, shown, 100, 0);
    expect(r.x).toBeCloseTo(0.4 - 0.05);
    expect(r.y).toBeCloseTo(0.2);
    expect(r.w).toBe(0.25);
    expect(panRegion(region, undefined, shown, 99999, -99999)).toMatchObject({ x: 0, y: 0.75 });
  });

  it('widget: rodinha aproxima e afasta mantendo a proporção e o ponto sob o ponteiro', () => {
    const region = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 };
    const closer = zoomRegion(region, 0.5, 0, 0);
    expect(closer).toEqual({ x: 0.2, y: 0.2, w: 0.2, h: 0.1 });
    const far = zoomRegion(null, 2);
    expect(far).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const out = zoomRegion(region, 10);
    expect(out.h).toBeCloseTo(0.5);
    expect(out.w / out.h).toBeCloseTo(2);
  });

  it('guia do centro: encaixa só perto do centro e solta ao afastar', () => {
    // Tela 1920, fonte de 400: centrada quando x = 760.
    expect(snapToCenterX(752, 400, 1920, 10)).toEqual({ x: 760, snapped: true });
    expect(snapToCenterX(769, 400, 1920, 10)).toEqual({ x: 760, snapped: true });
    expect(snapToCenterX(740, 400, 1920, 10)).toEqual({ x: 740, snapped: false });
  });

  it('tamanho do conteúdo: 200% mostra metade, mantém o centro e não passa da página inteira', () => {
    const region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(contentZoom(region).value).toBeCloseTo(200);
    const bigger = setContentZoom(region, 400);
    expect(bigger.w).toBeCloseTo(0.25);
    expect(bigger.x + bigger.w / 2).toBeCloseTo(0.5);
    const smallest = setContentZoom(region, 10);
    expect(smallest).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(contentZoom({ x: 0, y: 0, w: 0.4, h: 0.8 }).min).toBeCloseTo(200);
  });
});

import { extendRegion as ext } from './compositor';
describe('widget: borda aumenta a moldura sem mudar o conteúdo', () => {
  const shown = { x: 100, y: 100, w: 400, h: 200 };
  const region = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  it('direita: mostra mais da página, escala igual, esquerda parada', () => {
    const r = ext(region, undefined, shown, 'r', 100);
    expect(r.region.w).toBeCloseTo(0.5);
    expect(r.rect.w).toBeCloseTo(500);
    expect(r.rect.x).toBe(100);
    expect(r.rect.w / r.region.w).toBeCloseTo(shown.w / region.w);
  });
  it('esquerda puxada para fora: cresce para a esquerda, direita parada', () => {
    const r = ext(region, undefined, shown, 'l', -100);
    expect(r.region.x).toBeCloseTo(0.1);
    expect(r.rect.x + r.rect.w).toBeCloseTo(500);
  });
  it('topo: aumenta a altura para cima e para na borda da página', () => {
    const r = ext(region, undefined, shown, 't', -1000);
    expect(r.region.y).toBe(0);
    expect(r.region.h).toBeCloseTo(0.6);
    expect(r.rect.h / r.region.h).toBeCloseTo(shown.h / region.h);
    expect(r.rect.y + r.rect.h).toBeCloseTo(300);
  });
  it('base para dentro: diminui sem inverter', () => {
    const r = ext(region, undefined, shown, 'b', -10000);
    expect(r.region.h).toBeGreaterThan(0);
  });
  it('tela cheia: imagem inteira esticada até as bordas, sem corte', () => {
    const t = stretchTransform();
    expect(t.crop).toEqual({ l: 0, r: 0, t: 0, b: 0 });
    // Imagem quadrada (1080×1080) num programa 1920×1080: ocupa tudo.
    expect(placement({ x: 0, y: 0, w: 1080, h: 1080 }, t, { w: 1920, h: 1080 })).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    // Sem altura própria continua seguindo a proporção.
    expect(placement({ x: 0, y: 0, w: 1080, h: 1080 }, { x: 0, y: 0, w: 0.5, crop: t.crop }, { w: 1920, h: 1080 }).h).toBe(960);
  });
  it('centraliza sem mudar tamanho nem corte', () => {
    const crop = { l: 0.1, r: 0, t: 0, b: 0 };
    const t = centerTransform({ x: 100, y: 50, w: 400, h: 300 }, { w: 1920, h: 1080 }, { x: 0.05, y: 0.05, w: 400 / 1920, crop });
    expect(t.x * 1920).toBeCloseTo(760);
    expect(t.y * 1080).toBeCloseTo(390);
    expect(t.w * 1920).toBeCloseTo(400);
    expect(t.crop).toEqual(crop);
  });
  it('guia do centro na altura', () => {
    expect(snapToCenterY(385, 300, 1080, 10)).toEqual({ y: 390, snapped: true });
    expect(snapToCenterY(300, 300, 1080, 10)).toEqual({ y: 300, snapped: false });
  });
});
