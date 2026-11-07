# Folio for iPhone

Folio as a web app. It reads scanned PDFs and photos in Arabic, German and English, lets you correct the text against the scan, and exports text, a Folio Edition, a searchable PDF or an EPUB e-book.
It is plain HTML, CSS and JavaScript with no build step, and it runs offline once installed. Your files never leave the phone.

## Folder structure

```
folio-web/
├── index.html            the app (main file)
├── style.css             paper-and-ink design, light and dark
├── manifest.json         name, colours, icons for the Home Screen
├── sw.js                 service worker: caches everything for offline use
├── .nojekyll             tells GitHub Pages to serve files as they are
├── icons/                icon-180 (iPhone), icon-192, icon-512
├── js/
│   ├── app.js            screens, sheets, menu, backup
│   ├── store.js          IndexedDB: sessions and original files
│   ├── reader.js         PDF pages → text (text layer or OCR)
│   ├── export.js         Markdown / plain text / HTML
│   ├── words.js          word frequencies
│   ├── edition.js        Folio Edition (print / save as PDF)
│   ├── searchable.js     the scan with selectable text
│   └── epub.js           EPUB 3 e-book
└── vendor/               pdf.js, Tesseract.js + Arabic/German/English
                          models, pdf-lib, Noto Naskh Arabic (≈17 MB)
```

## Put it on GitHub Pages (free)

1. Sign in at github.com → **+** (top right) → **New repository**. Name it e.g. `folio`, set it **Public**, and click **Create repository**.
2. On the empty repository page click **uploading an existing file**. Drag in **everything inside** `folio-web/`: the files *and* the `icons`, `js` and `vendor` folders, so `index.html` sits at the top level and not inside a `folio-web` folder.
   `.nojekyll` is hidden in Finder. Press **⌘⇧.** to show it, then drag it in too.
3. Click **Commit changes**.
4. Open **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. After a minute or two the page shows your address: `https://YOUR-NAME.github.io/folio/`.

To update later, upload the changed files the same way. Then open `sw.js`, change `folio-v1` to `folio-v2` (and so on), and upload it too, so phones fetch the new version.

## Install on iPhone

1. Open the address in **Safari** (not Chrome; only Safari can add web apps on iOS).
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open Folio from the Home Screen once **while online** and leave it open about a minute. It saves its ~17 MB of reading tools; after that it works in airplane mode.
4. Now and then tap **Export backup** on the start screen and save the file to Files or iCloud Drive. iOS may clear a web app's storage if the phone runs short of space or the app goes unused for weeks; **Import backup** brings everything back.

## What could not be carried over from the Mac app, and why

| Mac app | iPhone web app | Why |
|---|---|---|
| Apple Vision text recognition | Tesseract.js | Web apps cannot use Apple's built-in OCR. Tesseract is very good on clean German, a little weaker on Arabic and on poor scans, and slower (a few seconds per page). |
| Tables & lists engine (pdf2md's table detection) | Paragraphs, headings and lists only | It is a Python/Swift tool that needs the Mac. |
| Quick Action in Finder, "Open With", drag-and-drop | Open the file from inside Folio (Files, iCloud Drive, Photos) | iOS will not let a web app appear in the Share sheet or open files from other apps. |
| Save dialogs | The share sheet (Save to Files, AirDrop, Books…) | Web apps cannot write to a folder you choose. |
| Full menu of keyboard shortcuts | ⌘F, ⌘Z / ⇧⌘Z and the arrow keys, with a keyboard attached | A web app has no menu bar to hold the rest. |
| Edition with exact page layout | Printed through Safari's print → Save as PDF | Safari does its own pagination, so margins and page breaks can differ slightly. If printing does nothing from the Home Screen app, use **Save as web page** and print that. |
| Reading in the background | Only while Folio is open on screen | iOS pauses web apps as soon as you switch away. Keep the screen on during long reads; Folio resumes where it stopped. |
| Unlimited storage | Limited, and can be cleared by iOS | Hence the Back up / Restore buttons. |
| Works at once | Needs one online visit first | It must download the 17 MB of OCR models before it can work offline. |

Both versions can now export an **EPUB**. In the web app: **Menu → E-book**. In the Mac app: **Document → Save E-book (EPUB)… (⌥⌘E)**, the **E-book** section of Folio Edition, or the Export sheet.
