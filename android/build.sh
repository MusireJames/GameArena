#!/usr/bin/env bash
# Builds and signs gamearena.apk without Android Studio. Needs: JDK 17, android.jar (API 34), apktool jar (for aapt2), dex2jar, uber-apk-signer.
# Edit the paths below, then run: bash build.sh
set -e
T=${TOOLS:-/tmp/apk}; JDK=$(ls -d $T/jdk-17*); J=$JDK/bin
cd "$(dirname "$0")"; rm -rf build && mkdir -p build/classes
unzip -p $T/apktool.jar prebuilt/linux/aapt2 > build/aapt2 && chmod +x build/aapt2
$J/javac --release 8 -classpath $T/android.jar -d build/classes src/com/gamearena/app/MainActivity.java
(cd build/classes && $J/jar cf ../classes.jar .)
PATH=$J:$PATH bash $T/dex-tools-v2.4/d2j-jar2dex.sh build/classes.jar -f -o build/classes.dex
build/aapt2 compile --dir res -o build/res.zip
build/aapt2 link -I $T/android.jar --manifest AndroidManifest.xml --min-sdk-version 24 --target-sdk-version 33 --version-code ${VERSION_CODE:-1} --version-name ${VERSION_NAME:-1.0} -o build/base.apk build/res.zip
python3 - <<'PY'
import zipfile
src = zipfile.ZipFile('build/base.apk'); out = zipfile.ZipFile('build/unsigned.apk', 'w')
for i in src.infolist(): out.writestr(i, src.read(i.filename), compress_type=i.compress_type)
out.write('build/classes.dex', 'classes.dex', compress_type=zipfile.ZIP_DEFLATED); out.close()
PY
[ -f keys/gamearena.keystore ] || { mkdir -p keys; $J/keytool -genkeypair -keystore keys/gamearena.keystore -alias gamearena -keyalg RSA -keysize 2048 -validity 36500 -storepass "${KS_PASS:?set KS_PASS}" -keypass "${KS_PASS}" -dname "CN=GameArena, O=GameArena, C=KE"; }
$J/java -jar $T/uber.jar -a build/unsigned.apk --ks keys/gamearena.keystore --ksAlias gamearena --ksPass "${KS_PASS:?set KS_PASS}" --ksKeyPass "${KS_PASS}" --out build/signed --allowResign
cp build/signed/*-aligned-signed.apk gamearena.apk && echo "Built android/gamearena.apk"
