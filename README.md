# Converta — File & Image Converter Site

A ready-to-run site for converting image formats, images↔PDF, and
Word/Excel/PowerPoint↔PDF.

## Run locally

```bash
npm install
node server/index.js
```

The server comes up on `http://localhost:3000`.

## Server prerequisites (for a real deployment)

This project uses **LibreOffice** (headless) for document conversion,
**poppler-utils** for PDF→image, and **pdf2docx** (Python) specifically for
PDF→Word — LibreOffice's generic PDF import filter frequently mangles
complex-script text (Arabic, Persian, Kurdish, etc.) into disconnected
presentation-form glyphs and flattens tables into loose text; pdf2docx
reconstructs real tables and correct logical Unicode text instead. On
Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y libreoffice poppler-utils python3-pip
pip3 install pdf2docx --break-system-packages
```

Without libreoffice/poppler-utils, only image↔image and image→PDF conversion
will work. Without pdf2docx, PDF→Word automatically falls back to
LibreOffice's import (lower quality on tables and complex scripts, but still
functional).

The in-browser visual PDF editor (`/convert/edit-pdf.html`) needs no extra
system packages — it renders PDFs client-side using pdf.js, whose two
required files are already committed as static assets in
`public/js/vendor/` (not pulled in via npm at install time).

## Before you go live, make sure to

1. **Buy a real domain and hosting** — a VPS (2GB RAM minimum, LibreOffice
   headless is memory-hungry) from a provider that supports free SSL
   (Let's Encrypt).
2. **Real contact email** — replace `contact@YOURDOMAIN.com` in
   `public/pages/contact.html`.
3. **AdSense and where you register from**: under Google's current rules,
   Iran is not on AdSense's list of supported countries. To sign up and
   receive payouts you'll need an address/payment method outside Iran —
   this is a legal/tax matter, look into it carefully before launching for real.
4. **Reverse proxy + HTTPS**: put nginx or Caddy in front of Node (see
   `deploy/nginx.conf.example`).
5. **Automatic cleanup of temp folders** in case the server crashes
   mid-conversion — a simple cron job to delete anything older than an
   hour in `uploads/` and `converted/`:
   ```
   0 * * * * find /path/to/converter-site/server/uploads -mmin +60 -delete
   0 * * * * find /path/to/converter-site/server/converted -mmin +60 -delete
   ```
6. **Tune the rate limit** (`server/index.js`) for real traffic — it's
   currently set to 60 requests per 15 minutes per IP.
7. **Watch capacity**: every Office conversion spawns a new LibreOffice
   process; under heavy concurrent load you'll want a request queue
   (e.g. `p-queue`).

## Project structure

```
server/
  index.js          Express entry point
  routes/convert.js  Conversion API routes
  lib/converters.js  Conversion logic (sharp / pdf-lib / LibreOffice / poppler)
public/
  index.html         Homepage and converter UI
  pages/             About, Privacy, Terms, Contact, FAQ
  css/style.css
  js/app.js
```

## API

| Route | Input | Output |
|---|---|---|
| `POST /api/convert/image` | `files[]` (one or more images) + `target` | Converted file, or a zip |
| `POST /api/convert/image-to-pdf` | `files[]` (images) | One PDF |
| `POST /api/convert/pdf-to-image` | `file` (one PDF) + `target` | Image, or a zip |
| `POST /api/convert/office` | `file` + `target` (pdf/docx/xlsx/pptx/...) | Converted file |

Every route has been tested and works end-to-end on this server
(image↔image, image→PDF, PDF→image, docx→pdf, pdf→docx, xlsx→pdf).
