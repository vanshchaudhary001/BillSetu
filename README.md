# Bill Setu

**Paper bill → checked record → owner-confirmed filing draft.**

Bill Setu is a local-first GST preparation prototype for micro-enterprises that still work with paper receipts, handwritten bills, and sales registers. It helps a shop owner capture, understand, and correct records before handing them to a CA or the official GST workflow. Its job is to make the review step understandable; it does not replace a tax professional or file a return.

## Run on your computer

From this folder, run:

```powershell
npm install
npm run dev
```

Open the URL Vite prints in the terminal (the current desktop preview uses `http://localhost:5174`). Keep that terminal running while you use the app. To make a production bundle, run `npm run build`; to serve the bundle locally, run `npm run preview`.

## Judge-ready walkthrough

1. Start on the Overview page. The sample workspace is synthetic and already contains B2B, B2C, purchase, and attention-needed records.
2. Select **Run 30-second demo**. Open its flagged bill. Correct fields against the source, use the arithmetic suggestion, then confirm only after reviewing the findings.
3. Visit **Help centre → Test document safety** to replay a synthetic prompt-injection document. Its embedded instruction is treated as untrusted text and R12 quarantines it.
4. To show intake, use **Download sample register** below the upload area, then upload that CSV. It contains a clean B2B row, a high-value B2C row missing an address, and a B2C row that can be reviewed normally.
5. Open **GST rule guide**, **CA workspace**, and **Exports** to show the explainable checks, hand-off workflow, and different outputs. The GSTR-1-shaped JSON is a prototype draft, not an upload-ready GSTN file.

## What works in this prototype

- Dashboard, record search (including `Ctrl/⌘ K`), status filters, attention queue, review modal, and mobile layouts.
- Manual bill entry and batch intake of JPG/JPEG, PNG, WebP, PDF, CSV, and XLSX files. Each file is limited to 10 MB; each batch to 5 files; register imports to 500 data rows. XLSX reads the first worksheet.
- Browser-side OCR for image bills and scanned PDFs, plus text extraction from searchable PDFs. OCR handles English only, checks up to the first five PDF pages, and is an assistive capture signal—not a calibrated probability. The first OCR run downloads the English model; the guided replay does not need it.
- CSV/XLSX header mapping for common invoice number, buyer, GSTIN, date, taxable value, tax heads, total, place-of-supply, address, and HSN/SAC columns. Import the sample CSV to see the expected shape.
- Twelve deterministic, visible preparation checks: GSTIN structure/checksum, line arithmetic, total reconciliation, place-of-supply/tax split, post-transition rate advisory, invoice numbering and duplicates, required fields, HSN/SAC digit count, duplicate fingerprint, return-bucket suggestion, Composition guard, and document safety/capture quality.
- Human review and correction, explicit owner confirmation, CA escalation, source preview, local action history, synthetic security replay, and English/Hindi navigation and review hints.
- Local state in browser storage and original uploaded files in IndexedDB where available. Exports include a GSTR-1-shaped JSON draft, a multi-sheet CA workbook, and a formula-safe CSV list.

## Where this fits beside existing products

GST billing and compliance software already exists. For example, myBillBook describes invoicing, inventory, and a bill-scan workflow; ClearTax describes both billing-to-GST hand-off and GST return preparation/reconciliation. Bill Setu does not claim those products lack these capabilities. The prototype explores a narrower experience: a paper-first micro-business owner sees the source next to extracted fields, gets plain-language reasons for each flag, and decides what to confirm before exporting a local review pack. That is a product hypothesis to validate with shopkeepers and CAs, not a claim of an empty market. [myBillBook](https://mybillbook.in/s/features/gst-billing-and-invoicing/) · [ClearOne / ClearGST](https://cleartax.in/clearone/gst-connector-for-smes/index.html) · [ClearTax GST](https://cleartax.in/gst).

## Important limits before using real business records

- No backend, account system, cloud sync, CA login/share link, live GST portal lookup, or direct return filing is connected. Records remain in this browser; exports are downloaded files that the user must share through their own channel.
- Local browser storage is a prototype convenience, not encrypted, managed production storage. Do not use a shared or public computer for sensitive records. Reset in Settings clears the local sample workspace and imported file copies.
- Image/PDF extraction can miss or misread handwriting, tables, dates, and tax heads. Always compare every field with the source. English OCR model download requires an internet connection the first time it is used.
- The checks are guardrails, not a legal opinion. A structurally valid GSTIN is not proof that it is active. Tax rates and HSN/SAC classification, place-of-supply edge cases, reverse charge, tax treatment, and ITC eligibility need current official/CA verification.
- The sample JSON uses a Bill Setu draft structure and **is not certified against the current GSTN Offline Tool schema**. Validate using the official utility before any filing workflow. GSTN's own guide documents the official GSTR-1 tables and threshold logic; for example, interstate B2C invoices above ₹1 lakh route to B2CL for applicable periods from August 2024. [GSTN GSTR-1 guide](https://tutorial.gst.gov.in/userguide/returns/Creation_of_Outward_Supplies_Return_in_GSTR-1.htm) · [GSTN Offline Tool guide](https://tutorial.gst.gov.in/downloads/invoiceuploadofflineutility.pdf).
- Hindi is currently a navigation and review-hint layer, not a full translation of every screen.

## Implementation

- React + Vite frontend; responsive CSS; Lucide icons.
- Deterministic GST checks in `src/lib/gst.js`—no model decides tax, totals, or approval.
- Intake in `src/lib/intake.js` using Papa Parse, ExcelJS, PDF.js, and Tesseract.js.
- Browser persistence in `src/lib/storage.js`; export generation in `src/lib/exports.js`.
- Synthetic seed records and the downloadable register are examples only. Replace them with an approved, privacy-safe dataset when one is provided.
