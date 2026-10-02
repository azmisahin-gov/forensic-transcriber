#!/usr/bin/env bash
#
# Generate the synthetic Turkish fixtures used by the integration tests.
#
# Requires espeak-ng and ffmpeg (developer tools only; never needed at runtime).
# The audio is synthetic speech from original Turkish sentences: no real
# recording and no personal data, fully redistributable.
#
#   tests/fixtures/tr-offset.wav        one utterance after a known 3.0 s silence
#   tests/fixtures/tr-known-events.wav  three utterances separated by silence
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-${SCRIPT_DIR}/../tests/fixtures}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${OUT_DIR}"
cd "${WORK}"

say() { # say <file> <text>
  espeak-ng -v tr -s 145 -w "$1.wav" "$2" 2>/dev/null
  ffmpeg -hide_banner -loglevel error -y -i "$1.wav" -ar 16000 -ac 1 "$1_16.wav"
}
silence() { # silence <file> <seconds>
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t "$2" "$1.wav"
}

say s1 "Merhaba, bu bir adli ses kaydı inceleme testidir."
say s2 "Kayıt saat on dört sıfır beşte başlamıştır."
say s3 "Telefon numarası beş yüz otuz iki, kırk bir, seksen yedi."
silence lead 3.0
silence gap 2.5
silence tail 1.0

# tr-offset.wav: 3.0 s silence + utterance + 1.0 s tail.
ffmpeg -hide_banner -loglevel error -y \
  -i lead.wav -i s1_16.wav -i tail.wav \
  -filter_complex "[0][1][2]concat=n=3:v=0:a=1[out]" -map "[out]" \
  -ar 16000 -ac 1 "${OUT_DIR}/tr-offset.wav"

# tr-known-events.wav: short lead + three utterances separated by 2.5 s silence.
ffmpeg -hide_banner -loglevel error -y \
  -i s1_16.wav -i gap.wav -i s2_16.wav -i gap.wav -i s3_16.wav \
  -filter_complex "[0][1][2][3][4]concat=n=5:v=0:a=1[out]" -map "[out]" \
  -ar 16000 -ac 1 "${OUT_DIR}/tr-known-events.wav"

echo "Wrote:"
for f in tr-offset tr-known-events; do
  d=$(ffprobe -hide_banner -v error -show_entries format=duration -of default=nw=1:nk=1 "${OUT_DIR}/${f}.wav")
  echo "  ${OUT_DIR}/${f}.wav  ${d}s"
done
