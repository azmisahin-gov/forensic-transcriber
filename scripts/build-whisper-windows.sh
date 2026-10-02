#!/usr/bin/env bash
#
# Cross-build whisper-cli.exe for Windows x64 from a pinned whisper.cpp release
# using mingw-w64. Produces a fully static binary (no libgomp/libstdc++ DLLs)
# so it runs on a clean Windows machine with no extra runtime.
#
# Requires: git, cmake, mingw-w64, and (optionally) a CUDA-enabled toolchain.
# CUDA builds must be produced on Windows or with the NVIDIA cross toolchain;
# this script produces the CPU build that ships as the universal fallback.
#
# Usage: scripts/build-whisper-windows.sh [output-dir]

set -euo pipefail

WHISPER_VERSION="v1.9.4"
REPO_URL="https://github.com/ggml-org/whisper.cpp.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_ROOT="${FT_WHISPER_BUILD_ROOT:-${ROOT_DIR}/build/whisper.cpp}"
OUT_DIR="${1:-${ROOT_DIR}/vendor/win-x64/bin}"
TOOLCHAIN="${SCRIPT_DIR}/mingw-w64-x86_64.cmake"

if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  echo "mingw-w64 is required (x86_64-w64-mingw32-gcc not found)." >&2
  echo "On Debian/Ubuntu: sudo apt-get install -y mingw-w64" >&2
  exit 1
fi

mkdir -p "${BUILD_ROOT}"
if [ ! -d "${BUILD_ROOT}/.git" ]; then
  git clone --depth 1 --branch "${WHISPER_VERSION}" "${REPO_URL}" "${BUILD_ROOT}"
fi

cd "${BUILD_ROOT}"
rm -rf build-win
cmake -B build-win \
  -DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DCMAKE_EXE_LINKER_FLAGS="-static -static-libgcc -static-libstdc++"
cmake --build build-win --config Release -j"$(nproc)"

mkdir -p "${OUT_DIR}"
cp build-win/bin/whisper-cli.exe "${OUT_DIR}/"
echo "Built ${OUT_DIR}/whisper-cli.exe"
sha256sum "${OUT_DIR}/whisper-cli.exe"

# Verify the binary only depends on Windows system DLLs.
echo "DLL dependencies:"
x86_64-w64-mingw32-objdump -p "${OUT_DIR}/whisper-cli.exe" | grep -i "DLL Name" | sort -u
