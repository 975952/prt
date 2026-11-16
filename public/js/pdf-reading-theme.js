// The bundled PDF.js 6.3 renderer exposes its per-task CanvasGraphics through
// RenderTask. Keep this adapter local to a screen render: never mutate PDF
// operators, shared objects, prototypes, or screenshot/export render tasks.
export const NIGHT_PAPER = '#222426';
const NIGHT_INK = [226, 228, 230];
const NIGHT_BG = [34, 36, 38];

function nightColor(color, brightness = 90) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  // Preserve color coding in diagrams and links. Only neutral ink and paper
  // are reversed; photographs and raster figures never enter this function.
  if (Math.max(...rgb) - Math.min(...rgb) > 24) return color;
  const level = rgb.reduce((a, b) => a + b, 0) / (3 * 255);
  const strength = Number.isFinite(Number(brightness)) ? Math.max(65, Math.min(100, Number(brightness))) / 100 : .9;
  return '#' + NIGHT_INK.map((ink, i) => Math.round(ink * strength + (NIGHT_BG[i] - ink * strength) * level).toString(16).padStart(2, '0')).join('');
}

/** Keep text hue while bounding perceptual lightness and chroma. Images and
 * colored vector fills never pass through this text-only conversion. */
export function nightTextColor(color, saturation = 50, brightness = 90) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  if (Math.max(...rgb) - Math.min(...rgb) <= 24) return nightColor(color, brightness);
  const [r, g, b] = rgb.map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  const lightness = .2104542553 * l + .793617785 * m - .0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s;
  const bb = .0259040371 * l + .7827717662 * m - .808675766 * s;
  const chroma = Math.hypot(a, bb);
  const strength = Number.isFinite(Number(saturation)) ? Math.max(0, Math.min(100, Number(saturation))) : 50;
  const L = Math.max(.70, Math.min(.76, lightness));
  let C = Math.min(chroma, strength * .0022);
  let linear;
  // Reduce chroma, rather than clipping channels (which would shift the hue).
  for (let i = 0; i < 40; i++) {
    const A = a * C / chroma, B = bb * C / chroma;
    const ll = (L + .3963377774 * A + .2158037573 * B) ** 3;
    const mm = (L - .1055613458 * A - .0638541728 * B) ** 3;
    const ss = (L - .0894841775 * A - 1.291485548 * B) ** 3;
    linear = [4.0767416621 * ll - 3.3077115913 * mm + .2309699292 * ss,
      -1.2684380046 * ll + 2.6097574011 * mm - .3413193965 * ss,
      -.0041960863 * ll - .7034186147 * mm + 1.707614701 * ss];
    if (linear.every(v => v >= 0 && v <= 1)) break;
    C *= .9;
  }
  return '#' + linear.map(v => {
    const x = Math.max(0, Math.min(1, v));
    return Math.round(255 * (x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055)).toString(16).padStart(2, '0');
  }).join('');
}

export function applyNightReading(task, OPS, { saturation = 50, brightness = 90 } = {}) {
  let installed = false;
  task.onContinue = resume => {
    if (!installed) {
      installed = true;
      const gfx = task._internalRenderTask?.gfx;
      if (!gfx || typeof gfx[OPS.setFillRGBColor] !== 'function' || typeof gfx[OPS.setStrokeRGBColor] !== 'function') {
        task.cancel();
        throw new Error('PDF 夜读渲染器不兼容，请切换为米宣主题');
      }
      const originals = new Map();
      const raw = color => originals.get(color) || color;
      const convert = color => {
        const mapped = nightColor(color, brightness);
        originals.set(mapped, color);
        return mapped;
      };
      let maskDepth = 0;
      const wrap = (name, make) => {
        const original = gfx[name];
        if (typeof original !== 'function') return;
        gfx[name] = make(original);
        if (Number.isFinite(OPS[name])) gfx[OPS[name]] = gfx[name];
      };
      for (const name of ['setFillRGBColor', 'setStrokeRGBColor']) {
        wrap(name, original => function (index, color) {
          return original.call(this, index, maskDepth ? color : convert(color));
        });
      }
      const textColors = new Map();
      const textColor = color => {
        if (!textColors.has(color)) textColors.set(color, nightTextColor(raw(color), saturation, brightness));
        return textColors.get(color);
      };
      wrap('showText', original => function (...args) {
        if (maskDepth) return original.apply(this, args);
        const fill = this.current.fillColor, stroke = this.current.strokeColor;
        const ctxFill = this.ctx.fillStyle, ctxStroke = this.ctx.strokeStyle;
        this.current.fillColor = this.ctx.fillStyle = textColor(fill);
        this.current.strokeColor = this.ctx.strokeStyle = textColor(stroke);
        try { return original.apply(this, args); }
        finally {
          this.current.fillColor = fill; this.current.strokeColor = stroke;
          this.ctx.fillStyle = ctxFill; this.ctx.strokeStyle = ctxStroke;
        }
      });
      // Masks encode coverage/luminance, not visible ink. Keep their colors and
      // stencil-image paint unchanged, including nested transparency groups.
      wrap('beginGroup', original => function (index, group) {
        if (group.smask) maskDepth++;
        const result = original.call(this, index, group);
        if (maskDepth) {
          this.ctx.fillStyle = this.current.fillColor = raw(this.current.fillColor);
          this.ctx.strokeStyle = this.current.strokeColor = raw(this.current.strokeColor);
        }
        return result;
      });
      wrap('endGroup', original => function (index, group) {
        const result = original.call(this, index, group);
        if (group.smask) maskDepth--;
        return result;
      });
      for (const name of ['paintImageMaskXObject', 'paintImageMaskXObjectRepeat', 'paintImageMaskXObjectGroup', 'paintSolidColorImageMask']) {
        wrap(name, original => function (...args) {
          const color = this.current.fillColor, style = this.ctx.fillStyle;
          this.ctx.fillStyle = this.current.fillColor = raw(color);
          try { return original.apply(this, args); }
          finally { this.current.fillColor = color; this.ctx.fillStyle = style; }
        });
      }
      gfx.ctx.fillStyle = gfx.current.fillColor = convert(gfx.current.fillColor);
      gfx.ctx.strokeStyle = gfx.current.strokeColor = convert(gfx.current.strokeColor);
    }
    resume();
  };
}
