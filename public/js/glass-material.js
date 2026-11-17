/* The optical layer is separate from text and PDF pixels. Only its rounded
   edge refracts; the center stays still while the card is moved or resized. */
export const CARD_MATERIAL_DEFAULTS = Object.freeze({
  liquid: Object.freeze({ transparency: 55, blur: 1.2, refraction: 60 }),
  frosted: Object.freeze({ transparency: 63, blur: 15, refraction: 60 }),
});

let controller;
export function updateTranslationMaterial(options) {
  const card = document.getElementById('translationCard');
  if (!card) return;
  controller ||= createMaterial(card);
  controller.update(options);
}

function createMaterial(card) {
  const ns = 'http://www.w3.org/2000/svg';
  const svgNode = (name, attributes = {}) => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const layer = document.createElement('div');
  layer.className = 'translation-material';
  layer.setAttribute('aria-hidden', 'true');
  card.prepend(layer);
  const svg = svgNode('svg', { width: 0, height: 0, 'aria-hidden': 'true', class: 'glass-filter-defs' });
  const defs = svgNode('defs');
  const filter = svgNode('filter', { id: 'prt-translation-refraction', x: 0, y: 0,
    filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
  const map = svgNode('feImage', { result: 'edge-map', x: 0, y: 0, preserveAspectRatio: 'none' });
  const displacement = svgNode('feDisplacementMap', { in: 'SourceGraphic', in2: 'edge-map',
    scale: 24, xChannelSelector: 'R', yChannelSelector: 'G' });
  filter.append(map, displacement); defs.append(filter); svg.append(defs); document.body.append(svg);
  let current = {}, timer = 0, lastSize = '';

  const paint = () => {
    if (!current.enabled) { layer.style.backdropFilter = ''; return; }
    displacement.setAttribute('scale', String(current.refraction * .4));
    layer.style.backdropFilter = current.mode === 'liquid' && lastSize
      ? `url(#prt-translation-refraction) blur(${current.blur}px) saturate(1.2)`
      : `blur(${current.blur}px) saturate(.85)`;
  };
  const resize = () => {
    timer = 0;
    if (!current.enabled || current.mode !== 'liquid') return;
    const width = card.clientWidth, height = card.clientHeight;
    if (!width || !height) return;
    const key = `${width}/${height}`;
    if (key === lastSize) { paint(); return; }
    lastSize = key;
    const radius = Math.min(22, width / 2, height / 2), band = 13;
    // Bound allocation and work during live resize, independent of screen DPI.
    const w = Math.min(512, width), h = Math.min(512, height);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const context = canvas.getContext('2d');
    const image = context.createImageData(w, h);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const x = (px + .5) * width / w - width / 2, y = (py + .5) * height / h - height / 2;
      const qx = Math.abs(x) - (width / 2 - radius), qy = Math.abs(y) - (height / 2 - radius);
      const cx = Math.max(qx, 0), cy = Math.max(qy, 0), length = Math.hypot(cx, cy);
      const distance = -(length + Math.min(Math.max(qx, qy), 0) - radius);
      let nx = 0, ny = 0;
      if (length) { nx = Math.sign(x) * cx / length; ny = Math.sign(y) * cy / length; }
      else if (qx > qy) nx = Math.sign(x); else ny = Math.sign(y);
      const edge = Math.sin(Math.min(1, Math.max(0, 1 - distance / band)) * Math.PI / 2);
      const i = (py * w + px) * 4;
      image.data[i] = Math.round(128 + nx * 110 * edge);
      image.data[i + 1] = Math.round(128 + ny * 110 * edge);
      image.data[i + 2] = 128; image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    for (const node of [filter, map]) { node.setAttribute('width', width); node.setAttribute('height', height); }
    map.setAttribute('href', canvas.toDataURL());
    paint();
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(resize, 60); };
  const observer = new ResizeObserver(schedule); observer.observe(card);
  return {
    update(options) {
      current = options;
      card.dataset.material = options.enabled ? options.mode : '';
      const base = options.mode === 'frosted' ? .34 : .92;
      card.style.setProperty('--card-veil', String(Math.max(.1, Math.min(.94, base + (55 - options.transparency) / 110))));
      card.style.setProperty('--card-fill', String(Math.max(.12, Math.min(.86, .56 + (55 - options.transparency) / 140))));
      card.style.setProperty('--card-sheen', String(Math.max(.08, 1 - options.transparency / 110)));
      paint(); schedule();
    },
  };
}
