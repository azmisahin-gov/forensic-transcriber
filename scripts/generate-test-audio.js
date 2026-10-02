'use strict';

/**
 * Generate synthetic Turkish test audio of a requested duration.
 *
 *   node scripts/generate-test-audio.js --minutes 5 --out tests/fixtures/tr-5min.wav
 *
 * The audio is synthetic (espeak-ng TTS) and therefore fully redistributable.
 * It exists so RTF / memory can be measured without shipping real recordings.
 * Requires espeak-ng and ffmpeg (developer tools only; never needed at runtime).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const minutes = Number(arg('--minutes', '1'));
const out = path.resolve(arg('--out', path.join('tests', 'fixtures', `tr-${minutes}min.wav`)));

// Varied Turkish content: names, numbers, dates, phone-like sequences and
// conversational fillers, so the benchmark is not a single repeated token.
const SENTENCES = [
  'Merhaba, bu kayıt transkripsiyon doğrulama amacıyla hazırlanmıştır.',
  'Görüşme saat on dört sıfır beşte başlamıştır.',
  'Telefon numarası beş yüz otuz iki, kırk bir, seksen yedi.',
  'Ahmet Yılmaz ve Ayşe Demir toplantıda hazır bulundu.',
  'Dosya numarası iki bin yirmi altı, üç yüz kırk iki.',
  'Ödeme on iki bin beş yüz Türk lirası olarak belirlendi.',
  'Kayıt İstanbul, Ankara ve İzmir arasındaki görüşmeleri içeriyor.',
  'Sözleşme otuz bir Aralık iki bin yirmi beş tarihinde imzalandı.',
  'Bu bölümde arka plan gürültüsü ve konuşma dili örnekleri vardır.',
  'Bir sonraki adımda tutanak düzenlenecektir.',
  'Sanık ifadesinde olay yerinde bulunduğunu belirtti.',
  'Tanık beyanı ile kamera kaydı arasında fark bulunmaktadır.',
  'Kısaltma olarak T BMM ve M İ T geçmektedir.',
  'Yüzde otuz beş oranında artış gözlemlendi.',
  'Kayıt cihazı model numarası X Y Z dört yüz.',
  'Konuşmacılar sırayla söz aldı ve tartışma sona erdi.',
];

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-gen-'));
  const parts = [];
  SENTENCES.forEach((s, i) => {
    const wav = path.join(tmp, `s${i}.wav`);
    // Alternate two pitch levels so a diarizer has something to separate.
    const pitch = i % 2 === 0 ? '115' : '155';
    sh('espeak-ng', ['-v', 'tr', '-p', String(pitch), '-s', '150', '-w', wav, s]);
    parts.push(wav);
  });

  const silence = path.join(tmp, 'sil.wav');
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '0.6', silence]);

  // Build a base block: silence + each sentence interleaved with silence.
  const listFile = path.join(tmp, 'concat.txt');
  const lines = [silence, ...parts.flatMap((p) => [p, silence])];
  fs.writeFileSync(listFile, lines.map((l) => `file '${l.replace(/'/g, "'\\''")}'`).join('\n'));

  const base = path.join(tmp, 'base.wav');
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '16000', '-ac', '1', base]);

  const baseDuration = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', base], {
      encoding: 'utf8',
    }).trim()
  );
  const targetSeconds = minutes * 60;
  const loops = Math.max(1, Math.ceil(targetSeconds / baseDuration));

  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Repeat the base with ffmpeg's stream loop, then trim to the exact duration.
  sh('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-stream_loop', String(loops),
    '-i', base,
    '-t', String(targetSeconds),
    '-ar', '16000', '-ac', '1',
    out,
  ]);

  const finalDuration = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], {
      encoding: 'utf8',
    }).trim()
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`${out} — ${finalDuration.toFixed(1)}s (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}

main();
