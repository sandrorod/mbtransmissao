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
# Assinatura com certificado próprio e FIXO (build/assinatura, fora do git). Com a assinatura ad-hoc ("-")
# cada versão tinha uma identidade diferente para o macOS: a permissão de câmera/microfone dada a uma versão
# continuava "permitida" mas não valia para a nova, e a lista de aparelhos ficava sem resposta para sempre.
# Com o certificado, a identidade (bundle id + certificado) é a mesma em todas as versões.
KC="$PWD/build/assinatura/estudio.keychain-db"
CERT=3F58F994CFD8BFEE35E40DDAB62E51F567C787D9
if [ -f "$KC" ] && [ -f build/assinatura/senha.txt ]; then
  ORIG=$(security list-keychains -d user | tr -d '"' | xargs)
  security list-keychains -d user -s $ORIG "$KC"
  security unlock-keychain -p "$(cat build/assinatura/senha.txt)" "$KC"
  # O --deep não assina executáveis dentro de Resources (o FFmpeg fica em app.asar.unpacked): assina antes.
  codesign --force --sign "$CERT" "$APP/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" || { security list-keychains -d user -s $ORIG; exit 1; }
  codesign --force --deep --sign "$CERT" "$APP" || { security list-keychains -d user -s $ORIG; exit 1; }
  security list-keychains -d user -s $ORIG
else
  echo "AVISO: sem build/assinatura (certificado fixo); assinando ad-hoc. Quem atualizar precisará permitir câmera/microfone de novo."
  codesign --force --sign - "$APP/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg"
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"
codesign -dr - "$APP"
env -u ELECTRON_RUN_AS_NODE npx electron-builder --mac dmg --universal --prepackaged "$APP" -c.mac.identity=null
ls -la dist/*.dmg
