#!/usr/bin/env bash
set -euo pipefail

if ! command -v emcmake >/dev/null || ! command -v cmake >/dev/null; then
  echo "This reproducibility build requires Emscripten 4.0.20 and CMake on PATH." >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd "$script_dir/../.." && pwd)
scratch_dir=$(mktemp -d /tmp/webai-gguf-split.XXXXXX)
trap 'rm -rf -- "$scratch_dir"' EXIT
update_assets=${1:-}
if [[ -n "$update_assets" && "$update_assets" != "--update" ]]; then
  echo "Usage: $0 [--update]" >&2
  exit 2
fi

git clone --filter=blob:none --no-checkout https://github.com/ggerganov/llama.cpp.git "$scratch_dir/llama.cpp"
git -C "$scratch_dir/llama.cpp" fetch --depth=1 origin dd4623a74f0c85e6b1dd9ee99a92b9c67cac3708
git -C "$scratch_dir/llama.cpp" checkout --detach FETCH_HEAD
cp "$script_dir/webai-gguf-plan.cpp" "$scratch_dir/llama.cpp/tools/gguf-split/"
git -C "$scratch_dir/llama.cpp" apply "$script_dir/llama-cpp.patch"

mkdir -p "$scratch_dir/build"
cd "$scratch_dir/build"
emcmake cmake ../llama.cpp \
  -DLLAMA_WASM_MEM64=OFF \
  -DLLAMA_BUILD_HTML=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=OFF \
  -DLLAMA_BUILD_APP=OFF \
  -DLLAMA_BUILD_TOOLS=ON \
  -DLLAMA_CURL=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_RPC=OFF \
  -DGGML_BACKEND_DL=OFF \
  -DLLAMA_OPENSSL=OFF
emmake cmake --build . --target webai-gguf-plan -j2

js_sha=$(sha256sum bin/webai-gguf-plan.js | cut -d' ' -f1)
wasm_sha=$(sha256sum bin/webai-gguf-plan.wasm | cut -d' ' -f1)
echo "$js_sha  bin/webai-gguf-plan.js"
echo "$wasm_sha  bin/webai-gguf-plan.wasm"

if [[ "$update_assets" == "--update" ]]; then
  asset_dir="$project_root/public/runtime/gguf-split"
  mkdir -p "$asset_dir"
  find "$asset_dir" -maxdepth 1 -type f -name 'webai-gguf-plan.*.js' -delete
  find "$asset_dir" -maxdepth 1 -type f -name 'webai-gguf-plan.*.wasm' -delete
  cp bin/webai-gguf-plan.js "$asset_dir/webai-gguf-plan.${js_sha:0:8}.js"
  cp bin/webai-gguf-plan.wasm "$asset_dir/webai-gguf-plan.${wasm_sha:0:8}.wasm"
  echo "Updated checked-in assets in $asset_dir"
fi
