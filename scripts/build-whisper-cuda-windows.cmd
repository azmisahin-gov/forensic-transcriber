@echo off
REM ============================================================================
REM Build a CUDA-enabled whisper-cli.exe for Windows x64.
REM
REM Produces vendor\win-x64\bin\gpu\whisper-cli.exe plus the redistributable
REM NVIDIA runtime DLLs it needs (per the CUDA Toolkit EULA, Attachment A).
REM
REM Requirements: Visual Studio 2022 (Desktop C++), CMake, Git, and the NVIDIA
REM CUDA Toolkit 12.x. This script must run on Windows or on the GitHub
REM windows-latest runner; the CUDA compiler cannot be produced from Linux.
REM
REM Usage:  scripts\build-whisper-cuda-windows.cmd [output-dir]
REM ============================================================================
setlocal enabledelayedexpansion

set WHISPER_VERSION=v1.9.4
set REPO_URL=https://github.com/ggml-org/whisper.cpp.git
set ROOT=%~dp0..
set OUT=%~1
if "%OUT%"=="" set OUT=%ROOT%\vendor\win-x64\bin\gpu
set BUILD_ROOT=%ROOT%\build\whisper.cpp

if "%CUDA_PATH%"=="" (
  echo ERROR: CUDA_PATH is not set. Install the NVIDIA CUDA Toolkit 12.x first.
  exit /b 1
)

where nvcc >nul 2>nul
if errorlevel 1 (
  echo ERROR: nvcc not found on PATH. Install the CUDA Toolkit or add %CUDA_PATH%\bin to PATH.
  exit /b 1
)

if not exist "%BUILD_ROOT%\.git" (
  git clone --depth 1 --branch %WHISPER_VERSION% %REPO_URL% "%BUILD_ROOT%"
  if errorlevel 1 exit /b 1
)

pushd "%BUILD_ROOT%"
if exist build-cuda rmdir /s /q build-cuda

cmake -B build-cuda -A x64 -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release ^
  -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF ^
  -DWHISPER_BUILD_EXAMPLES=ON
if errorlevel 1 (popd & exit /b 1)

cmake --build build-cuda --config Release --target whisper-cli
if errorlevel 1 (popd & exit /b 1)
popd

if not exist "%OUT%" mkdir "%OUT%"
copy /y "%BUILD_ROOT%\build-cuda\bin\Release\whisper-cli.exe" "%OUT%\whisper-cli.exe" >nul
if errorlevel 1 exit /b 1

REM Stage the redistributable CUDA runtime DLLs (EULA Attachment A).
copy /y "%CUDA_PATH%\bin\cudart64_*.dll" "%OUT%\" >nul 2>nul
copy /y "%CUDA_PATH%\bin\cublas64_*.dll" "%OUT%\" >nul 2>nul
copy /y "%CUDA_PATH%\bin\cublasLt64_*.dll" "%OUT%\" >nul 2>nul

echo Built %OUT%\whisper-cli.exe
echo Runtime DLLs staged from %CUDA_PATH%\bin
dir /b "%OUT%"
endlocal
