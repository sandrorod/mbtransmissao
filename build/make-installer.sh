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
# Nome do pacote SEM acento: o Electron monta o caminho dos auxiliares (Helper) a partir do CFBundleName e
# confere byte a byte com o caminho real no disco. Com "ú" o disco guarda u + acento (NFD) e o Info.plist
# "ú" (NFC): os bytes diferem e o Electron fecha o app ao abrir ("unexpected helper executable").
# O nome com acento aparece só como CFBundleDisplayName.
APP="dist/mac-universal/Estudio ao Vivo.app"
# Assinatura local (ad-hoc). NÃO usar certificado próprio: o Gatekeeper recusa assinatura de certificado que a
# Apple não reconhece e o app nem abre pelo Finder (testado em 20/11). Com ad-hoc cada versão tem identidade
# nova para o macOS; o próprio app apaga a permissão antiga de câmera/microfone na 1ª abertura de uma versão
# nova (electron/main: resetMediaOnNewBuild), e o macOS pergunta de novo.
# O --deep não assina executáveis dentro de Resources (o FFmpeg fica em app.asar.unpacked): assina antes.
codesign --force --sign - "$APP/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
codesign -dr - "$APP"
env -u ELECTRON_RUN_AS_NODE npx electron-builder --mac dmg --universal --prepackaged "$APP" -c.mac.identity=null
ls -la dist/*.dmg
