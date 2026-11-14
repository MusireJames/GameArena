# GameArena Android app (gamearena.apk)

A full-screen app that loads your hosted GameArena site. When you update the website, the app updates with it.

## Install
1. Copy `gamearena.apk` to the phone (USB, WhatsApp "document", Google Drive...).
2. Open it. Android asks you to allow installs from that app (Files, Chrome or WhatsApp): allow it once.
3. If Play Protect warns about an unrecognised developer, choose "Install anyway". This is normal for apps not from the Play Store.

## First launch
The app asks for your site address once, for example `https://yourdomain.com`. The phone must be able to reach it.
- Testing at home: run `ngrok http 3000` on the computer and enter the https address it shows. Or use the computer's Wi-Fi address, such as `http://192.168.1.10:3000`, with the phone on the same Wi-Fi and Windows Firewall allowing port 3000.
- To change the address later, wait for the "Can't reach GameArena" box and choose "Change address", or clear the app's storage in Android settings.

## Things to know
- The Google button is hidden inside the app, because Google does not allow sign-in inside an embedded browser. Players use their phone number, password and email code. Players who joined with Google can use "Forgot your password?" to set a password and then sign in to the app.
- For the Play Store you need a different kind of build (an AAB that opens your site in Chrome, which also supports Google sign-in). Use https://www.pwabuilder.com with your live address, then put the app's signing fingerprint in `ANDROID_PACKAGE` and `ANDROID_SHA256` in `.env`. The site already has the icons, manifest and offline page it needs.
- Real-money play still needs your Gambling Regulatory Authority licence, and Google Play has its own rules for gambling apps.

## Rebuilding
`build.sh` rebuilds and signs the APK (needs JDK 17, android.jar, apktool, dex2jar and uber-apk-signer). Source is in `src/`, `res/` and `AndroidManifest.xml`.
Signing key: `keys/gamearena.keystore`, alias `gamearena`. The password is in `keys/PASSWORD.txt` (this folder is git-ignored; never commit it).
Back up the `keys` folder somewhere safe. Updates to an installed app must be signed with the same key.
