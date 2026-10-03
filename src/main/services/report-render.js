'use strict';

const zlib = require('node:zlib');
const { createZip } = require('./zip');

/**
 * DOCX and PDF rendering for the report workspace.
 *
 * Both writers are implemented in-repo with no dependency: a DOCX is a small
 * OOXML ZIP package, and the PDF is a single-font, text-only document. That
 * keeps the offline-first guarantee (nothing to download) and the dependency
 * surface small. They are deliberately plain — a professional, printable
 * document, not a designed brochure.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ------------------------------------------------------------------- DOCX

/** Convert a block of text into WordprocessingML paragraphs. */
function textToParagraphs(text, { style } = {}) {
  const lines = String(text ?? '').split('\n');
  return lines
    .map((line) => {
      const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
      const runs = line.length
        ? `<w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r>`
        : '';
      return `<w:p>${pPr}${runs}</w:p>`;
    })
    .join('');
}

function reportToDocx(report) {
  const body = [];
  body.push(
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${esc(report.title)}</w:t></w:r></w:p>`
  );
  body.push(
    textToParagraphs(
      [
        `Dosya: ${report.case.case_id} — ${report.case.title}`,
        report.case.file_number ? `Dosya numarası: ${report.case.file_number}` : '',
        report.case.authority ? `Mahkeme / merci: ${report.case.authority}` : '',
        `Oluşturulma: ${report.generated_at}`,
      ]
        .filter(Boolean)
        .join('\n')
    )
  );
  for (const s of report.sections) {
    body.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(s.title)}</w:t></w:r></w:p>`
    );
    body.push(textToParagraphs(s.body || ''));
  }
  body.push(textToParagraphs(report.notice));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${body.join('\n')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: stylesXml },
  ]);
}

// -------------------------------------------------------------------- PDF

/**
 * Encode a string for a PDF literal string. The plain single-font PDF uses the
 * built-in Helvetica, which cannot represent Turkish letters (ş, ğ, ı, İ) or
 * any non-Latin-1 character. Rather than emit '?' the encoder transliterates
 * them to a readable ASCII equivalent, so the printable PDF stays legible. The
 * DOCX and HTML outputs carry the exact UTF-8 text and are the authoritative
 * formats for Turkish characters.
 */
const PDF_TRANSLITERATE = Object.freeze({
  'ş': 's', 'Ş': 'S', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I',
  'ç': 'c', 'Ç': 'C', 'ö': 'o', 'Ö': 'O', 'ü': 'u', 'Ü': 'U',
  'â': 'a', 'Â': 'A', 'î': 'i', 'Î': 'I', 'û': 'u', 'Û': 'U',
  '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...',
  '\u00a0': ' ', '₺': 'TL',
});

function pdfText(value) {
  const s = String(value ?? '');
  let out = '';
  for (const ch of s) {
    if (ch === '(' || ch === ')' || ch === '\\') {
      out += `\\${ch}`;
      continue;
    }
    const mapped = PDF_TRANSLITERATE[ch];
    const c = mapped !== undefined ? mapped : ch;
    for (const mc of c) {
      const code = mc.codePointAt(0);
      if (code >= 32 && code <= 255) out += mc;
      else out += '?';
    }
  }
  return out;
}

/** Wrap text to a max character count per line. */
function wrapLine(text, max = 92) {
  const words = String(text ?? '').split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    if (!current.length) current = w;
    else if (current.length + 1 + w.length <= max) current += ` ${w}`;
    else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length || !lines.length) lines.push(current);
  return lines;
}

function buildPdfLines(report) {
  const lines = [];
  lines.push({ text: report.title, size: 16, bold: true });
  lines.push({ text: `Dosya: ${report.case.case_id} — ${report.case.title}`, size: 9 });
  if (report.case.file_number) lines.push({ text: `Dosya numarası: ${report.case.file_number}`, size: 9 });
  if (report.case.authority) lines.push({ text: `Mahkeme / merci: ${report.case.authority}`, size: 9 });
  lines.push({ text: `Oluşturulma: ${report.generated_at}`, size: 9 });
  lines.push({ text: '', size: 9 });
  for (const s of report.sections) {
    lines.push({ text: s.title, size: 12, bold: true });
    for (const raw of String(s.body || '').split('\n')) {
      for (const w of wrapLine(raw)) lines.push({ text: w, size: 10 });
    }
    lines.push({ text: '', size: 10 });
  }
  for (const w of wrapLine(report.notice)) lines.push({ text: w, size: 8 });
  return lines;
}

function reportToPdf(report) {
  const pageHeight = 842;
  const pageWidth = 595;
  const marginTop = 56;
  const marginBottom = 48;
  const lineHeight = 14;

  const all = buildPdfLines(report);
  const perPage = Math.floor((pageHeight - marginTop - marginBottom) / lineHeight);
  const pages = [];
  for (let i = 0; i < all.length; i += perPage) pages.push(all.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  const objects = [];
  // 1: Catalog, 2: Pages, then per page: page + content. Font is the last object.
  const pageObjectIds = pages.map((_, i) => 3 + i * 2);
  const fontId = 3 + pages.length * 2;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;

  pages.forEach((pageLines, i) => {
    const pageId = pageObjectIds[i];
    const contentId = pageId + 1;
    let y = pageHeight - marginTop;
    const streamParts = ['BT'];
    for (const line of pageLines) {
      const font = line.bold ? '/F2' : '/F1';
      streamParts.push(`${font} ${line.size} Tf`);
      streamParts.push(`1 0 0 1 ${marginTop} ${y} Tm`);
      streamParts.push(`(${pdfText(line.text)}) Tj`);
      y -= lineHeight;
    }
    streamParts.push('ET');
    const stream = streamParts.join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  // Assemble with a cross-reference table.
  let pdf = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i += 1) {
    if (!objects[i]) continue;
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const maxId = objects.length - 1;
  pdf += `xref\n0 ${maxId + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= maxId; i += 1) {
    const off = offsets[i] || 0;
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { reportToDocx, reportToPdf, wrapLine };
