#!/bin/sh
# Gera o instalador universal (Mac com chip Apple e Mac Intel) em dist/.
# O ffmpeg-static só baixa o FFmpeg do Mac atual; aqui entra o binário universal (x64 + arm64, versão b6.1.1).
set -e
cd "$(dirname "$0")/.."
FF=node_modules/ffmpeg-static/ffmpeg
UNI=build/ffmpeg/ffmpeg-universal
if [ ! -f "$UNI" ]; then
  echo "Falta $UNI (lipo de ffmpeg-darwin-x64 + ffmpeg-darwin-arm64 da release b6.1.1 do ffmpeg-static)."; exit 1
fi
cp "$FF" build/ffmpeg/ffmpeg-original
cp "$UNI" "$FF"
trap 'cp build/ffmpeg/ffmpeg-original "$FF"' EXIT
rm -rf dist
# 1) app universal (sem dmg) 2) assinatura local (sem ela o Mac com chip Apple diz que o app está "danificado")
# 3) dmg com o app já assinado
env -u ELECTRON_RUN_AS_NODE npx electron-builder --mac dir --universal -c.mac.identity=null
APP="dist/mac-universal/Estúdio ao Vivo.app"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
env -u ELECTRON_RUN_AS_NODE npx electron-builder --mac dmg --universal --prepackaged "$APP" -c.mac.identity=null
ls -la dist/*.dmg
