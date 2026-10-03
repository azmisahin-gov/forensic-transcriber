'use strict';

const { SEGMENT_STATUS } = require('../../shared/constants');

/**
 * Report workspace: a structured, technical document assembled from the case's
 * own verified data.
 *
 * The report is a *technical* product. It organises facts the operator has
 * already confirmed (assignment details, evidence list and hashes, engine and
 * model used, transcript excerpts with timestamps). It deliberately contains no
 * automated legal assessment, no classification and no opinion: those sections
 * are left for the expert to write. The software structures the material; it
 * does not decide anything.
 *
 * Templates follow the section structure the Ministry of Justice publishes for
 * expert reports (Hukuk/Ceza/Savcılık/İcra). They are parametric: the operator
 * can rename, reorder and add sections. No official document is bundled.
 */

const TEMPLATES = Object.freeze({
  generic: {
    label: 'Genel',
    sections: [
      'Görevlendirme',
      'İnceleme Konusu',
      'İncelemeye Esas Materyaller',
      'İnceleme Yöntemi',
      'Kullanılan Teknik Araçlar',
      'Bulgular',
      'Transkripsiyon Sonuçları',
      'Sorular ve Cevapları',
      'Sonuç',
      'Ekler',
    ],
  },
  hukuk: {
    label: 'Hukuk Mahkemeleri / İdare / Vergi',
    sections: [
      'Görevlendirme ve Taraflar',
      'İnceleme Konusu ve Kapsamı',
      'İncelemeye Esas Materyaller',
      'İnceleme Yöntemi',
      'Kullanılan Teknik Araçlar',
      'Bulgular',
      'Transkripsiyon Sonuçları',
      'Sonuç',
      'Ekler',
    ],
  },
  ceza: {
    label: 'Ceza Mahkemeleri',
    sections: [
      'Görevlendirme',
      'İnceleme Konusu',
      'İncelemeye Esas Materyaller',
      'İnceleme Yöntemi',
      'Kullanılan Teknik Araçlar',
      'Bulgular',
      'Transkripsiyon Sonuçları',
      'Sonuç',
      'Ekler',
    ],
  },
  savcilik: {
    label: 'Cumhuriyet Başsavcılığı',
    sections: [
      'Görevlendirme',
      'Soruşturma Konusu',
      'İncelemeye Esas Materyaller',
      'İnceleme Yöntemi',
      'Kullanılan Teknik Araçlar',
      'Bulgular',
      'Transkripsiyon Sonuçları',
      'Sonuç',
      'Ekler',
    ],
  },
  icra: {
    label: 'İcra',
    sections: [
      'Görevlendirme',
      'İnceleme Konusu',
      'İncelemeye Esas Materyaller',
      'İnceleme Yöntemi',
      'Kullanılan Teknik Araçlar',
      'Bulgular',
      'Transkripsiyon Sonuçları',
      'Sonuç',
      'Ekler',
    ],
  },
});

const SECTION_KEYS = Object.freeze({
  'Görevlendirme': 'assignment',
  'Görevlendirme ve Taraflar': 'assignment',
  'Soruşturma Konusu': 'assignment',
  'İnceleme Konusu': 'subject',
  'İnceleme Konusu ve Kapsamı': 'subject',
  'İncelemeye Esas Materyaller': 'materials',
  'İnceleme Yöntemi': 'method',
  'Kullanılan Teknik Araçlar': 'tools',
  'Transkripsiyon Sonuçları': 'transcripts',
  'Sorular ve Cevapları': 'questions',
  'Ekler': 'attachments',
});

const METHOD_TEXT =
  'İncelemeye esas ses kayıtları, orijinal dosyaları değiştirilmeden bu bilgisayarda yerel olarak ' +
  'çözümlenmiştir. Kayıtlar 16 kHz mono çalışma kopyasına dönüştürülmüş ve otomatik konuşma tanıma ' +
  'motoruyla metne dönüştürülmüştür. Otomatik çıktı, insan incelemesinden geçirilmiş ve gerekli ' +
  'düzeltmeler uzman tarafından yapılmıştır. Bu belge teknik bir çalışma ürünüdür; hukuki ' +
  'değerlendirme içermez.';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatClock(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const ms = Math.round((s % 1) * 1000);
  const total = Math.floor(s);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}.${p(ms, 3)}`;
}

/** Default section set for a template. */
function defaultSections(template = 'generic') {
  const tpl = TEMPLATES[template] || TEMPLATES.generic;
  return tpl.sections.map((title, i) => ({
    id: `SEC-${i + 1}`,
    title,
    body: '',
    auto: true,
  }));
}

function assignmentLines(kase) {
  const rows = [
    ['Dosya numarası', kase.file_number],
    ['Mahkeme / merci', kase.authority],
    ['Dosya türü', kase.case_type],
    ['Görevlendirme tarihi', kase.assignment_date],
    ['Teslim tarihi', kase.due_date],
  ];
  return rows.filter(([, v]) => String(v || '').trim());
}

/**
 * Populate the sections whose content can be derived from verified case data.
 * The operator's own text (Bulgular, Sonuç) is never generated.
 */
function autoPopulate(report, { caseRecord, evidence, transcripts, notes, engineInfo }) {
  const sections = (report && report.sections ? report.sections : defaultSections(report && report.template)).map((s) => ({ ...s }));
  const bodyFor = (key) => {
    const idx = sections.findIndex((s) => SECTION_KEYS[s.title] === key);
    return idx >= 0 ? sections[idx] : null;
  };

  const assignment = bodyFor('assignment');
  if (assignment) {
    const lines = assignmentLines(caseRecord);
    if (caseRecord.assignment_description) lines.push(['Görevlendirme açıklaması', caseRecord.assignment_description]);
    assignment.body = lines.map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  const subject = bodyFor('subject');
  if (subject && !subject.body) {
    subject.body = String(caseRecord.scope || '').trim();
  }

  const materials = bodyFor('materials');
  if (materials) {
    materials.body = evidence
      .map((ev, i) => {
        const parts = [
          `${i + 1}. ${ev.original_name}`,
          `   SHA-256: ${ev.sha256}`,
          `   Boyut: ${ev.size_bytes} bayt`,
        ];
        if (ev.duration_seconds != null) parts.push(`   Süre: ${formatClock(ev.duration_seconds)}`);
        if (ev.format) parts.push(`   Biçim: ${ev.format}`);
        if (ev.audio_stream_count != null && ev.audio_stream_count > 1) {
          parts.push(`   Ses akışı sayısı: ${ev.audio_stream_count} (çözümlenen akış sırası: 0)`);
        }
        return parts.join('\n');
      })
      .join('\n\n');
  }

  const method = bodyFor('method');
  if (method && !method.body) method.body = METHOD_TEXT;

  const tools = bodyFor('tools');
  if (tools) {
    const lines = [];
    if (engineInfo) {
      if (engineInfo.engine) lines.push(`Motor: ${engineInfo.engine}`);
      if (engineInfo.engineVersion) lines.push(`Motor sürümü: ${engineInfo.engineVersion}`);
      if (engineInfo.modelId) lines.push(`Model: ${engineInfo.modelId}`);
      if (engineInfo.modelSha256) lines.push(`Model SHA-256: ${engineInfo.modelSha256}`);
      if (engineInfo.runtimeMode) lines.push(`Çalışma modu: ${String(engineInfo.runtimeMode).toUpperCase()}`);
      if (engineInfo.runtimeReason) lines.push(`Mod gerekçesi: ${engineInfo.runtimeReason}`);
      if (engineInfo.vadModel) lines.push(`Ses etkinlik sezimi: ${engineInfo.vadModel}`);
    }
    lines.push('Otomatik konuşma tanıma çıktısı makine çıktısıdır; uzman görüşü değildir.');
    tools.body = lines.join('\n');
  }

  const transcriptsSection = bodyFor('transcripts');
  if (transcriptsSection) {
    const blocks = transcripts.map((t) => {
      const lines = [`Delil: ${t.evidence_name}`];
      if (t.revision) lines.push(`Sürüm: ${t.revision.revision_id} (${t.revision.state}) — ${t.revision.created_at}`);
      if (t.excerpts && t.excerpts.length) {
        lines.push('');
        for (const ex of t.excerpts) {
          lines.push(`[${formatClock(ex.start)} – ${formatClock(ex.end)}] ${ex.speaker}${ex.status ? ` (${ex.status})` : ''}`);
          lines.push(ex.text);
          lines.push('');
        }
      } else {
        lines.push('(Bu delil için rapora alıntı eklenmemiş.)');
      }
      return lines.join('\n');
    });
    transcriptsSection.body = blocks.join('\n\n');
  }

  const questions = bodyFor('questions');
  if (questions) {
    const q = String(caseRecord.requested_questions || '').trim();
    questions.body = q;
  }

  const attachments = bodyFor('attachments');
  if (attachments) {
    const lines = notes
      .filter((n) => n.kind === 'NOTE' && n.category === 'RAPOR')
      .map((n) => `- ${n.body}`);
    if (evidence.length) {
      lines.push('Delil dosyaları teslim paketine eklenmiştir (bkz. teslim paketi manifesti).');
    }
    attachments.body = lines.join('\n');
  }

  return sections;
}

/** Build the transcript excerpt list used by the report and delivery package. */
function collectTranscripts({ caseRecord, evidence, storage }) {
  const out = [];
  for (const ev of evidence) {
    const t = storage.getTranscript(caseRecord.case_id, ev.evidence_id);
    if (!t) continue;
    const current = storage.getCurrentRevisionInfo(t.transcript_id);
    out.push({
      evidence_id: ev.evidence_id,
      evidence_name: ev.original_name,
      transcript_id: t.transcript_id,
      revision: current
        ? { revision_id: current.revision_id, state: current.state, created_at: current.created_at, run_id: current.run_id }
        : null,
      segments: storage.getSegments(t.transcript_id),
      excerpts: (current && current.segments ? current.segments : []).map((s) => ({
        start: s.start,
        end: s.end,
        speaker: s.speaker,
        status: s.status,
        text: s.text,
      })),
    });
  }
  return out;
}

/** Build a structured report document from case data, without writing anything. */
function buildReport({ caseRecord, evidence, transcripts, notes, engineInfo, report }) {
  const base = report || { template: 'generic', title: caseRecord.title, sections: defaultSections('generic') };
  const sections = autoPopulate(base, { caseRecord, evidence, transcripts, notes, engineInfo });
  return {
    case_id: caseRecord.case_id,
    template: base.template || 'generic',
    title: base.title || caseRecord.title,
    generated_at: new Date().toISOString(),
    case: {
      case_id: caseRecord.case_id,
      title: caseRecord.title,
      file_number: caseRecord.file_number || '',
      authority: caseRecord.authority || '',
      case_type: caseRecord.case_type || '',
      assignment_date: caseRecord.assignment_date || '',
      due_date: caseRecord.due_date || '',
      created_at: caseRecord.created_at,
    },
    engine: engineInfo || null,
    evidence: evidence.map((e) => ({
      evidence_id: e.evidence_id,
      original_name: e.original_name,
      sha256: e.sha256,
      size_bytes: e.size_bytes,
      duration_seconds: e.duration_seconds,
      format: e.format,
      audio_stream_count: e.audio_stream_count,
    })),
    transcripts,
    sections,
    notice:
      'Bu belge teknik bir çalışma ürünüdür. Otomatik konuşma tanıma çıktısı makine çıktısıdır ve ' +
      'uzman görüşü değildir. Belge hukuki değerlendirme, kimlik tespiti veya delilin gerçekliğine ' +
      'ilişkin bir sonuç içermez.',
  };
}

function reportToTxt(report) {
  const lines = [];
  lines.push(report.title.toUpperCase());
  lines.push('='.repeat(64));
  lines.push(`Dosya: ${report.case.case_id} — ${report.case.title}`);
  if (report.case.file_number) lines.push(`Dosya numarası: ${report.case.file_number}`);
  if (report.case.authority) lines.push(`Mahkeme / merci: ${report.case.authority}`);
  lines.push(`Oluşturulma: ${report.generated_at}`);
  lines.push('');
  for (const s of report.sections) {
    lines.push(s.title.toUpperCase());
    lines.push('-'.repeat(64));
    lines.push(s.body || '(boş)');
    lines.push('');
  }
  lines.push('='.repeat(64));
  lines.push(report.notice);
  return lines.join('\n');
}

/**
 * Delivery-readiness checklist. Every item that can be verified automatically
 * is; the rest are marked as needing the operator's own confirmation. The
 * checklist never asserts a legal conclusion — it only reflects the state of
 * the technical work.
 *
 * @returns {{items:Array<{id:string,label:string,status:string,detail:string}>, ready:boolean}}
 */
function buildChecklist({ caseRecord, evidence, transcripts, integrity = [], notes = [], report = null, dashboard = null }) {
  const items = [];
  const add = (id, label, ok, detail, manual = false) => {
    items.push({ id, label, status: manual ? (ok ? 'manual' : 'pending') : ok ? 'ok' : 'pending', detail, manual });
  };

  const assignmentFields = ['file_number', 'authority', 'due_date'];
  const missing = assignmentFields.filter((f) => !String(caseRecord[f] || '').trim());
  add('assignment', 'Görevlendirme bilgileri', missing.length === 0, missing.length ? `eksik: ${missing.join(', ')}` : 'tamam');

  const badEvidence = (integrity || []).filter((i) => i.status !== 'OK');
  add('integrity', 'Delil bütünlüğü', evidence.length > 0 && badEvidence.length === 0,
    evidence.length === 0 ? 'delil yok' : badEvidence.length ? `${badEvidence.length} dosyada sorun` : `${evidence.length} dosya doğrulandı`);

  add('reviewed', 'Tüm deliller incelendi', evidence.length > 0 && transcripts.length === evidence.length,
    `${transcripts.length}/${evidence.length} delil için transkript`);

  const humanStates = ['REVIEWED', 'EDITED', 'VERIFIED'];
  const allHuman = transcripts.length > 0 && transcripts.every((t) => t.revision && humanStates.includes(t.revision.state));
  add('revision', 'Transkript sürümü seçildi', allHuman,
    allHuman ? 'her delil için insan sürümü' : 'bazı deliller hâlâ makine sürümünde');

  const unclear = dashboard ? dashboard.unclear_segments : 0;
  add('unclear', 'Belirsiz bölümler incelendi', unclear === 0, unclear ? `${unclear} belirsiz bölüm` : 'belirsiz bölüm yok');

  add('speakers', 'Konuşmacı etiketleri gözden geçirildi', true, 'uzman onayı gerekir', true);

  const questions = String(caseRecord.requested_questions || '').trim();
  add('questions', 'İstenen sorular yanıtlandı', true, questions ? 'sorular kayıtlı; yanıtlar uzman onayı gerekir' : 'görevlendirmede soru yok', true);

  const filledSections = report && Array.isArray(report.sections) ? report.sections.filter((s) => String(s.body || '').trim()).length : 0;
  add('report', 'Rapor bölümleri tamamlandı', filledSections > 0, filledSections ? `${filledSections} bölüm dolu` : 'rapor henüz doldurulmadı');

  add('export', 'Dışa aktarım oluşturuldu', true, 'teslim paketi oluşturarak tamamlayın', true);

  const withHash = evidence.every((e) => e.sha256);
  add('hashes', 'SHA-256 kayıtlı', evidence.length > 0 && withHash, `${evidence.length} dosya`);

  add('backup', 'Yedek mevcut', true, 'case yedeğini alın', true);

  const ready = items.filter((i) => !i.manual).every((i) => i.status === 'ok');
  return { items, ready };
}

function reportToHtml(report) {
  const sections = report.sections
    .map(
      (s) => `  <section>
    <h2>${esc(s.title)}</h2>
    <pre>${esc(s.body || '')}</pre>
  </section>`
    )
    .join('\n');
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(report.title)}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; background: #f4f5f7; color: #1b1f24; }
    header { padding: 24px 40px; background: #10151c; color: #e8eef6; }
    header h1 { margin: 0 0 6px; font-size: 22px; }
    header p { margin: 2px 0; font-size: 13px; color: #9fb0c3; }
    main { padding: 20px 40px 60px; max-width: 900px; }
    section { background: #fff; border: 1px solid #e2e6ea; border-radius: 8px; padding: 16px 20px; margin: 14px 0; break-inside: avoid; }
    h2 { font-size: 15px; margin: 0 0 8px; color: #14314f; }
    pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 14px; line-height: 1.55; margin: 0; }
    .notice { padding: 14px 40px; background: #fff5e0; color: #6b4e00; font-size: 13px; border-bottom: 1px solid #f0dca6; }
    footer { padding: 16px 40px; font-size: 12px; color: #6b7683; border-top: 1px solid #e2e6ea; }
    @media print { body { background: #fff; } section { border: none; border-bottom: 1px solid #ddd; border-radius: 0; } header { background: #fff; color: #000; } header p { color: #444; } }
  </style>
</head>
<body>
  <header>
    <h1>${esc(report.title)}</h1>
    <p>Dosya ${esc(report.case.case_id)} — ${esc(report.case.title)}</p>
    ${report.case.file_number ? `<p>Dosya numarası ${esc(report.case.file_number)}</p>` : ''}
    ${report.case.authority ? `<p>${esc(report.case.authority)}</p>` : ''}
    <p>Oluşturulma ${esc(report.generated_at)}</p>
  </header>
  <div class="notice">${esc(report.notice)}</div>
  <main>
${sections}
  </main>
  <footer>Forensic Transcriber — 56.12 teknik çalışma ürünü.</footer>
</body>
</html>
`;
}

module.exports = {
  TEMPLATES,
  SECTION_KEYS,
  METHOD_TEXT,
  defaultSections,
  autoPopulate,
  collectTranscripts,
  buildReport,
  buildChecklist,
  reportToTxt,
  reportToHtml,
  formatClock,
  esc,
};
