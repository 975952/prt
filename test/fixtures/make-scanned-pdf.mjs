/** Synthetic scans with alternating image margins plus one mixed text/image page. */
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

export function writeScannedFixture(destination) {
  const width = 210, height = 297;
  const pixels = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3;
    if (x >= 24 && x < 186 && y >= 28 && y < 48) pixels.set([12, 128, 132], at);
    else if (y >= 66 && y < 245 && y % 11 < 2 && ((x >= 24 && x < 96) || (x >= 114 && x < 186)))
      pixels.set([42, 42, 42], at);
  }
  const objects = [];
  const add = value => { objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii')); return objects.length; };
  const catalog = add(''), pages = add('');
  const compressed = deflateSync(pixels);
  const image = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
    compressed, Buffer.from('\nendstream')]));
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const margin = i % 2 === 0 ? 12 : 0;
    const commands = `q ${420 - margin * 2} 0 0 594 ${margin} 0 cm /Scan Do Q\n`
      + (i === 3 ? 'BT /F1 12 Tf 24 20 Td (Mixed text and image page) Tj ET\n' : '');
    const content = add(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}endstream`);
    ids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 420 594] /Resources << /XObject << /Scan ${image} 0 R >> /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  objects[pages - 1] = Buffer.from(`<< /Type /Pages /Count 4 /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] >>`);
  const chunks = [Buffer.from('%PDF-1.4\n%SYNTHETIC\n')], offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(chunk); offset += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  fs.writeFileSync(destination, Buffer.concat(chunks));
}
