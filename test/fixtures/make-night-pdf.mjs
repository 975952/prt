import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

// Explicit white page fill, neutral text/strokes, repeated and clipped rotated
// raster images, and a transparency mask. No user papers are needed for QA.
export function writeNightFixture(destination) {
  const objects = [];
  const add = value => (objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii')), objects.length);
  const stream = (header, bytes) => add(Buffer.concat([
    Buffer.from(`<< ${header} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream'),
  ]));
  const catalog = add(''), pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pixels = Buffer.alloc(80 * 80 * 3, 255), mask = Buffer.alloc(80 * 80, 255);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
    if (x < 40 && y < 40) pixels.set([200, 108, 62], (y * 80 + x) * 3);
    if (x >= 40 && y < 40) pixels.set([30, 120, 170], (y * 80 + x) * 3);
    if (x < 40 && y >= 40) pixels.set([0, 0, 0], (y * 80 + x) * 3);
    if (x > 70) mask[y * 80 + x] = 128;
  }
  const smask = stream('/Type /XObject /Subtype /Image /Width 80 /Height 80 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', deflateSync(mask));
  const image = stream('/Type /XObject /Subtype /Image /Width 80 /Height 80 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', deflateSync(pixels));
  const alphaImage = stream(`/Type /XObject /Subtype /Image /Width 80 /Height 80 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask ${smask} 0 R`, deflateSync(pixels));
  const commands = `1 g 0 0 480 640 re f
0 g BT /F1 22 Tf 28 590 Td (Night reading: original images) Tj ET
0 G 2 w 28 565 m 452 565 l S
q 160 0 0 160 28 350 cm /Photo Do Q
q 160 0 0 160 240 350 cm /Photo Do Q
q 28 100 150 180 re W n 140 50 -50 140 60 120 cm /Photo Do Q
q 160 0 0 160 240 130 cm /Alpha Do Q
0 g BT /F1 16 Tf 28 52 Td (Text, rules and paper adapt to the theme.) Tj ET
`;
  const content = stream('', Buffer.from(commands, 'ascii'));
  const page = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 480 640] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Photo ${image} 0 R /Alpha ${alphaImage} 0 R >> >> /Contents ${content} 0 R >>`);
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  objects[pages - 1] = Buffer.from(`<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`);
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let offset = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(offset); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(chunk); offset += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  fs.writeFileSync(destination, Buffer.concat(chunks));
}
