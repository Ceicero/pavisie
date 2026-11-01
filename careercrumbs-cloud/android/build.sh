#!/usr/bin/env bash
# Builds a test APK of CareerCrumbs with the official Android SDK tools.
# Needs ANDROID_HOME (build-tools + a platform) and a JDK; GitHub's ubuntu runners have both.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
API="$(ls "$SDK/platforms" | sed 's/android-//' | grep -E '^[0-9]+$' | sort -n | tail -1)"
JAR="$SDK/platforms/android-$API/android.jar"
VERSION_CODE="${VERSION_CODE:-1}"
# Target Android 14 behaviour for test builds: targeting 15+ forces edge-to-edge drawing and
# 16+ stops calling onBackPressed, which this simple wrapper doesn't handle yet. A Play Store
# release will need to target the current level and handle both.
TARGET_SDK="${TARGET_SDK:-34}"
echo "build-tools: $BT  platform: android-$API  target: $TARGET_SDK  version: 0.1.$VERSION_CODE"

rm -rf build && mkdir -p build/assets build/classes build/dex
(cd .. && node build.cjs)
cp ../careercrumbs.html build/assets/index.html

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml -A build/assets \
  --min-sdk-version 24 --target-sdk-version "$TARGET_SDK" --version-code "$VERSION_CODE" --version-name "0.1.$VERSION_CODE-test" build/res.zip

javac -source 1.8 -target 1.8 -Xlint:-options -cp "$JAR" -d build/classes $(find src -name '*.java')
"$BT/d8" --release --min-api 24 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')

cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -p -f 4 build/unsigned.apk build/aligned.apk

# Test signing key, committed on purpose so each build installs over the last.
# Not for the Play Store: a store release gets its own private key.
"$BT/apksigner" sign --ks test.keystore --ks-pass pass:careercrumbs-test --key-pass pass:careercrumbs-test \
  --ks-key-alias test --out build/careercrumbs-test.apk build/aligned.apk
"$BT/apksigner" verify --print-certs build/careercrumbs-test.apk | head -3
ls -l build/careercrumbs-test.apk
