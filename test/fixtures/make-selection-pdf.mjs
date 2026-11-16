/** Synthetic two-column PDF with intentionally interleaved content-stream order. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const baselines = [720, 704, 688, 642, 626, 610, 480, 464, 448, 182, 166, 150];
export const selectionFixtureRows = [];
for (let page = 1; page <= 2; page++) {
  for (let index = 0; index < baselines.length; index++) {
    for (const column of ['L', 'R']) {
      const marker = `P${page}${column}${String(index + 1).padStart(2, '0')}`;
      selectionFixtureRows.push({ marker, page, column, x: column === 'L' ? 54 : 324,
        y: baselines[index], size: 9, text: `${marker} ${column === 'L' ? 'Left' : 'Right'} body sentence ${index + 1} stays in its column.` });
    }
  }
  selectionFixtureRows.push(
    { marker: `CAPTION_${page}`, page, column: 'L', x: 54, y: 665, size: 8,
      text: `Figure ${page}. CAPTION_${page} is a separate figure caption.` },
    { marker: `FOOTNOTE_${page}`, page, column: 'F', x: 54, y: 62, size: 8,
      text: `FOOTNOTE_${page} Explicitly selected notes must remain selectable.` },
  );
}

export function writeSelectionFixture(destination) {
  const objects = [];
  const add = (value) => { objects.push(Buffer.from(value, 'ascii')); return objects.length; };
  const catalog = add(''), pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const ids = [];
  const text = (row) => `BT /F1 ${row.size} Tf 1 0 0 1 ${row.x} ${row.y} Tm (${row.text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
  for (let page = 1; page <= 2; page++) {
    const rows = selectionFixtureRows.filter((row) => row.page === page);
    const commands = [text({ x: 54, y: 760, size: 14, text: `Synthetic two-column selection fixture - page ${page}` }),
      '0.8 G 54 506 216 70 re S 0 G', text({ x: 90, y: 535, size: 10, text: 'Synthetic figure area' })];
    // The drawing order is deliberately neither column-major nor physical page order.
    for (let index = 0; index < baselines.length; index++) {
      commands.push(...rows.filter((row) => row.y === baselines[index]).map(text));
      if (index === 2) commands.push(text(rows.find((row) => row.marker === `CAPTION_${page}`)));
      if (index === 5) commands.push(text(rows.find((row) => row.marker === `FOOTNOTE_${page}`)));
    }
    commands.push(text({ x: 300, y: 28, size: 8, text: String(page) }));
    const stream = `${commands.join('\n')}\n`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    ids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pages} 0 R >>`, 'ascii');
  objects[pages - 1] = Buffer.from(`<< /Type /Pages /Count 2 /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] >>`, 'ascii');
  const chunks = [Buffer.from('%PDF-1.4\n%SYNTHETIC\n', 'ascii')], offsets = [0];
  let offset = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    chunks.push(chunk); offset += chunk.length;
  }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.concat(chunks));
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const destination = process.env.FIXTURE_OUT || path.join(import.meta.dirname, '../artifacts/selection-two-column.pdf');
  console.log(writeSelectionFixture(destination));
}
