// The bundled PDF.js 6.3 renderer exposes its per-task CanvasGraphics through
// RenderTask. Keep this adapter local to a screen render: never mutate PDF
// operators, shared objects, prototypes, or screenshot/export render tasks.
export const NIGHT_PAPER = '#222426';
const NIGHT_INK = [226, 228, 230];
const NIGHT_BG = [34, 36, 38];

function nightColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  // Preserve color coding in diagrams and links. Only neutral ink and paper
  // are reversed; photographs and raster figures never enter this function.
  if (Math.max(...rgb) - Math.min(...rgb) > 24) return color;
  const level = rgb.reduce((a, b) => a + b, 0) / (3 * 255);
  return '#' + NIGHT_INK.map((ink, i) => Math.round(ink + (NIGHT_BG[i] - ink) * level).toString(16).padStart(2, '0')).join('');
}

export function applyNightReading(task, OPS) {
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
        const mapped = nightColor(color);
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
