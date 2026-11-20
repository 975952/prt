/** Synthetic single-page PDF with configurable metadata and first-page title. */
import fs from 'node:fs';
export function writeTitlePdf(destination, { title = 'Attention Is All You Need', metadata = title, padding = 0 } = {}) {
  const literal = s => String(s).replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 20 Tf 65 700 Td (${literal(title)}) Tj ET\nBT /F1 10 Tf 65 660 Td (Synthetic authors) Tj ET\n`
    + Array.from({ length: 25 }, (_, i) => `BT /F1 10 Tf 65 ${610 - i * 16} Td (This is synthetic body text for automated testing.) Tj ET`).join('\n')
    + (padding ? '\n%' + ' '.repeat(padding) + '\n' : '');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Title (${literal(metadata)}) >>`];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(destination, out, 'utf8');
}
