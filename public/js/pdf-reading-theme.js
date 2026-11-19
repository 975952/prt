// The bundled PDF.js 6.3 renderer exposes its per-task CanvasGraphics through
// RenderTask. Keep this adapter local to a screen render: never mutate PDF
// operators, shared objects, prototypes, or screenshot/export render tasks.
export const NIGHT_PAPER = '#222426';
const NIGHT_INK = [226, 228, 230];
const NIGHT_BG = [34, 36, 38];
const rectangularReadingPaths = new WeakSet();
function isRectanglePath(paths) {
  if (!paths || typeof paths !== 'object') return false;
  if (rectangularReadingPaths.has(paths)) return true;
  const shape = paths[0];
  const rectangle = shape?.length === 13 && shape[0] === 0 && shape[3] === 1
    && shape[6] === 1 && shape[9] === 1 && shape[12] === 4
    && ((shape[1] === shape[4] && shape[5] === shape[8] && shape[7] === shape[10] && shape[11] === shape[2])
      || (shape[2] === shape[5] && shape[4] === shape[7] && shape[8] === shape[11] && shape[10] === shape[1]));
  // PDF.js replaces drawOPS with a cached Path2D. Retain only shape identity,
  // not document data, so subsequent zoom/theme renders make the same decision.
  if (rectangle) rectangularReadingPaths.add(paths);
  return rectangle;
}

/** Some text PDFs paint an inset white sheet before their text. Let the screen's
 * paper surface show through that background, without recoloring illustrations,
 * later white cutouts, text, transparency masks, or screenshot/export renders. */
export function applyPaperReading(task, OPS) {
  let installed = false;
  task.onContinue = resume => {
    if (!installed) {
      installed = true;
      const gfx = task._internalRenderTask?.gfx;
      if (!gfx?.ctx || typeof gfx.constructPath !== 'function') { resume(); return; }
      let painted = false, maskDepth = 0;
      const wrap = (name, make) => {
        const original = gfx[name];
        if (typeof original !== 'function') return;
        gfx[name] = make(original);
        if (Number.isFinite(OPS[name])) gfx[OPS[name]] = gfx[name];
      };
      for (const name of ['showText', 'showType3Text', 'paintImageXObject', 'paintInlineImageXObject',
        'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup', 'shadingFill',
        'paintImageMaskXObject', 'paintImageMaskXObjectRepeat', 'paintImageMaskXObjectGroup', 'paintSolidColorImageMask']) {
        wrap(name, original => function (...args) { if (!maskDepth) painted = true; return original.apply(this, args); });
      }
      wrap('beginGroup', original => function (index, group) {
        if (group.smask) maskDepth++;
        return original.call(this, index, group);
      });
      wrap('endGroup', original => function (index, group) {
        const result = original.call(this, index, group);
        if (group.smask) maskDepth--;
        return result;
      });
      const fills = new Set([OPS.fill, OPS.eoFill].filter(Number.isFinite));
      const paints = new Set([OPS.fill, OPS.eoFill, OPS.stroke, OPS.closeStroke, OPS.fillStroke,
        OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(Number.isFinite));
      wrap('constructPath', original => function (index, op, paths, bounds) {
        const white = /^#(?:ff){3}$/i.test(this.current.fillColor);
        // PDF.js drawOPS: moveTo, three lineTo operations, closePath. Restrict
        // removal to rectangles; a white diagram polygon must stay visible.
        const rectangle = isRectanglePath(paths);
        let large = false;
        if (!painted && !maskDepth && white && rectangle && fills.has(op) && bounds?.length === 4) {
          const m = this.ctx.getTransform(), { width, height } = this.ctx.canvas;
          const corners = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[3]]]
            .map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
          const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
          const w = Math.max(0, Math.min(width, Math.max(...xs)) - Math.max(0, Math.min(...xs)));
          const h = Math.max(0, Math.min(height, Math.max(...ys)) - Math.max(0, Math.min(...ys)));
          large = w * h >= width * height * .25;
        }
        if (!large) {
          if (!maskDepth && paints.has(op)) painted = true;
          return original.call(this, index, op, paths, bounds);
        }
        const fill = this.current.fillColor, style = this.ctx.fillStyle;
        this.current.fillColor = this.ctx.fillStyle = 'transparent';
        try { return original.call(this, index, op, paths, bounds); }
        finally { this.current.fillColor = fill; this.ctx.fillStyle = style; }
      });
    }
    resume();
  };
}

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

const linearChannel = value => { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; };
const luminance = rgb => rgb.reduce((sum, value, i) => sum + linearChannel(value) * [.2126, .7152, .0722][i], 0);

/** Pale vector backgrounds need to darken with their text. Preserve their hue,
 * saturated diagram colors and all raster images; never apply this to masks. */
export function nightFillColor(color, brightness = 90) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const low = Math.min(...rgb), high = Math.max(...rgb);
  if (low < 170 || high < 215 || high - low < 6) return nightColor(color, brightness);
  const tinted = rgb.map((value, i) => NIGHT_BG[i] + 10 + (value - low) * 1.5);
  const ink = nightColor('#000000', brightness);
  const inkRgb = [1, 3, 5].map(i => parseInt(ink.slice(i, i + 2), 16));
  // Leave headroom for rounding and dimmed text: neutral labels on the new
  // background retain at least 4.5:1 contrast across the brightness range.
  const ceiling = Math.max(luminance(NIGHT_BG), Math.min(.06, (luminance(inkRgb) + .05) / 4.5 - .05) * .9);
  const scale = Math.min(1, ceiling / luminance(tinted));
  return '#' + tinted.map(value => {
    const x = linearChannel(value) * scale;
    return Math.round(255 * (x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055)).toString(16).padStart(2, '0');
  }).join('');
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
      // PDF.js clones graphics state with Object.create(). Original colors
      // belong to that state, rather than an inverse palette which can collide
      // when different pale fills map to the same dark color.
      const origins = { fill: Symbol('nightRawFill'), stroke: Symbol('nightRawStroke') };
      const raw = (current, kind) => {
        const color = current[`${kind}Color`], origin = current[origins[kind]];
        return origin?.mapped === color ? origin.raw : color;
      };
      const convert = (current, kind, color) => {
        const mapped = maskDepth ? color : (kind === 'fill' ? nightFillColor : nightColor)(color, brightness);
        current[origins[kind]] = { raw: color, mapped };
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
        const kind = name === 'setFillRGBColor' ? 'fill' : 'stroke';
        wrap(name, original => function (index, color) {
          return original.call(this, index, convert(this.current, kind, color));
        });
      }
      wrap('constructPath', original => function (index, op, paths, bounds) {
        isRectanglePath(paths);
        return original.call(this, index, op, paths, bounds);
      });
      const textColors = new Map();
      const textColor = color => {
        if (!textColors.has(color)) textColors.set(color, nightTextColor(color, saturation, brightness));
        return textColors.get(color);
      };
      wrap('showText', original => function (...args) {
        if (maskDepth) return original.apply(this, args);
        const fill = this.current.fillColor, stroke = this.current.strokeColor;
        const ctxFill = this.ctx.fillStyle, ctxStroke = this.ctx.strokeStyle;
        this.current.fillColor = this.ctx.fillStyle = textColor(raw(this.current, 'fill'));
        this.current.strokeColor = this.ctx.strokeStyle = textColor(raw(this.current, 'stroke'));
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
          this.ctx.fillStyle = this.current.fillColor = raw(this.current, 'fill');
          this.ctx.strokeStyle = this.current.strokeColor = raw(this.current, 'stroke');
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
          this.ctx.fillStyle = this.current.fillColor = raw(this.current, 'fill');
          try { return original.apply(this, args); }
          finally { this.current.fillColor = color; this.ctx.fillStyle = style; }
        });
      }
      gfx.ctx.fillStyle = gfx.current.fillColor = convert(gfx.current, 'fill', gfx.current.fillColor);
      gfx.ctx.strokeStyle = gfx.current.strokeColor = convert(gfx.current, 'stroke', gfx.current.strokeColor);
    }
    resume();
  };
}
