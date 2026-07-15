export type Lang = 'cs' | 'en'

// Czech pluralization: [1, 2–4, 5+ / 0]. e.g. czPlural(2, ['fotka','fotky','fotek'])
function czPlural(n: number, forms: [string, string, string]): string {
  if (n === 1) return forms[0]
  if (n >= 2 && n <= 4) return forms[1]
  return forms[2]
}

// Pick the UI language from the browser's preferred languages: the first
// entry matching Czech or English wins, everything else falls back to English.
export function detectLang(): Lang {
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const candidate of candidates) {
    const code = (candidate ?? '').toLowerCase()
    if (code.startsWith('cs')) return 'cs'
    if (code.startsWith('en')) return 'en'
  }
  return 'en'
}

const cs = {
  locale: 'cs-CZ',
  appTitle: 'Termální tisk',

  // Print form
  printImagesHeading: 'Tisk obrázků',
  dropHint: 'Přetáhněte obrázky kamkoliv, vložte z clipboardu nebo ',
  dropHintAction: 'vyberte ze souborů',
  dropOverlay: 'Pustit pro přidání obrázků',
  rotate: 'Otočit',
  remove: 'Odebrat',
  removeAll: 'Odebrat vše',
  copiesLabel: 'Počet výtisků',
  fewer: 'Méně',
  more: 'Více',
  preparing: 'Připravuji…',
  printingProgress: (current: number, total: number) => `Tisknu ${current}/${total}…`,
  printButton: (printerName: string | undefined, count: number) =>
    `Tisknout${printerName ? ` na ${printerName}` : ''}${count > 1 ? ` · ${count} ${czPlural(count, ['fotka', 'fotky', 'fotek'])}` : ''}`,
  sentToPrinter: 'Odesláno do tiskárny!',
  errorPrefix: 'Chyba',
  sharedFilename: 'sdilene.jpg',

  // Printer status badge
  statusOffline: 'offline',
  statusPaperOut: 'došel papír',
  statusCoverOpen: 'otevřené víko',
  statusNotReady: 'není připraveno',
  statusOnline: 'online',

  // Enumerations
  ditherLabels: {
    floyd: 'Floyd–Steinberg',
    atkinson: 'Atkinson',
    ordered: 'Ordered (rastr)',
    threshold: 'Práh (bez ditheru)',
  },
  formatLabels: {
    image: 'Obrázek',
    pdf: 'PDF',
    raster: 'Rastr',
    text: 'Text',
  },
  cutLabels: {
    full: 'Úplný střih',
    partial: 'Částečný střih',
    none: 'Bez střihu',
  },
  queueStateLabels: {
    printing: 'Tiskne se',
    queued: 'Ve frontě',
    waiting: 'Čeká na tiskárnu',
  },
  jobSourceLabels: {
    ipp: 'Systém',
    web: 'Web',
    reprint: 'Přetisk',
    test: 'Test',
  },
  pagesShort: (n: number) => `${n} str.`,
  genericError: 'chyba',

  // Machine-readable error codes returned by the backend. Unknown strings
  // (raw socket errors, pre-existing history entries) pass through untranslated.
  backendErrors: {
    too_many_requests: 'Příliš mnoho tiskových požadavků, zkus to za chvíli.',
    ip_required: 'IP je povinná',
    image_required: 'Je potřeba alespoň jeden obrázek',
    name_and_ip_required: 'Název a IP jsou povinné',
    preview_not_available: 'Náhled není k dispozici',
    job_not_available: 'Úloha nebo její data nejsou k dispozici',
    print_failed: 'chyba tisku',
    drawer_failed: 'zásuvka nereaguje',
    printer_timeout: 'tiskárna nereaguje (timeout 10 s)',
    no_target_printer: 'není nastavená cílová tiskárna',
  } as Record<string, string>,

  // Cash drawer + test receipt
  openingDrawer: 'Otevírám pokladní zásuvku…',
  drawerOpened: 'Pokladní zásuvka otevřena ✓',
  drawerFailed: (error: string) => `Zásuvku se nepodařilo otevřít: ${error}`,
  drawerFailedPlain: 'Zásuvku se nepodařilo otevřít',
  sendingTest: (ip: string) => `Posílám testovací lístek na ${ip}…`,
  testSent: (ip: string) => `Testovací lístek odeslán na ${ip} ✓`,
  testFailed: (ip: string, error: string) => `Tisk na ${ip} selhal: ${error}`,
  testSendError: (ip: string) => `Nepodařilo se odeslat test na ${ip}`,

  // Settings
  settingsSummary: 'Nastavení tisku',
  paperWidth: 'Šířka papíru',
  paperWidth80: '80 mm (576 bodů)',
  paperWidth58: '58 mm (384 bodů)',
  cutAfterPrint: 'Střih po tisku',
  dithering: 'Dithering',
  brightness: 'Jas',
  contrast: 'Kontrast',
  openDrawerButton: 'Otevřít pokladní zásuvku',

  // Queue + job history
  queueHeading: 'Fronta',
  recentJobs: 'Poslední úlohy',
  refresh: 'Obnovit',
  showPrintPreview: 'Zobrazit náhled tisku',
  printAgain: 'Vytisknout znovu',
  retry: 'Zkusit znovu',
  printPreviewAlt: 'Náhled tisku',
  downloadPreviewTitle: 'Stáhnout náhled (PNG)',
  downloadPreview: 'Stáhnout náhled',
  close: 'Zavřít',
  justNow: 'právě teď',
  momentAgo: 'před chvílí',
  minutesAgo: (m: number) => `před ${m} min`,

  // Printers section
  printersHeading: 'Tiskárny',
  searching: 'Hledám…',
  search: '↻ Vyhledat',
  noPrintersYet: 'Zatím žádná tiskárna — přidej ji níže.',
  defaultPrinterTitle: 'Výchozí tiskárna (Cmd/Ctrl+P i web tisk)',
  setAsDefault: 'Nastavit jako výchozí',
  defaultPrinterAria: 'Výchozí tiskárna',
  online: 'Online',
  offline: 'Offline',
  defaultBadge: 'výchozí',
  renameTitle: 'Přejmenovat',
  renameAria: (name: string) => `Přejmenovat ${name}`,
  printTestTitle: 'Vytisknout testovací lístek',
  testAria: (ip: string) => `Test na ${ip}`,
  removeAria: (name: string) => `Odebrat ${name}`,
  addPrinter: 'Přidat tiskárnu',
  thermalPrinterFallbackName: 'Termální tiskárna',
  namePlaceholder: 'Název',
  ipPlaceholder: 'IP adresa',
  portPlaceholder: 'Port (9100)',
  add: 'Přidat',
}

export type Messages = typeof cs

const en: Messages = {
  locale: 'en-US',
  appTitle: 'Thermal Print',

  // Print form
  printImagesHeading: 'Print images',
  dropHint: 'Drag images anywhere, paste from the clipboard or ',
  dropHintAction: 'browse files',
  dropOverlay: 'Drop to add images',
  rotate: 'Rotate',
  remove: 'Remove',
  removeAll: 'Remove all',
  copiesLabel: 'Copies',
  fewer: 'Fewer',
  more: 'More',
  preparing: 'Preparing…',
  printingProgress: (current: number, total: number) => `Printing ${current}/${total}…`,
  printButton: (printerName: string | undefined, count: number) =>
    `Print${printerName ? ` on ${printerName}` : ''}${count > 1 ? ` · ${count} ${count === 1 ? 'photo' : 'photos'}` : ''}`,
  sentToPrinter: 'Sent to the printer!',
  errorPrefix: 'Error',
  sharedFilename: 'shared.jpg',

  // Printer status badge
  statusOffline: 'offline',
  statusPaperOut: 'out of paper',
  statusCoverOpen: 'cover open',
  statusNotReady: 'not ready',
  statusOnline: 'online',

  // Enumerations
  ditherLabels: {
    floyd: 'Floyd–Steinberg',
    atkinson: 'Atkinson',
    ordered: 'Ordered (raster)',
    threshold: 'Threshold (no dither)',
  },
  formatLabels: {
    image: 'Image',
    pdf: 'PDF',
    raster: 'Raster',
    text: 'Text',
  },
  cutLabels: {
    full: 'Full cut',
    partial: 'Partial cut',
    none: 'No cut',
  },
  queueStateLabels: {
    printing: 'Printing',
    queued: 'Queued',
    waiting: 'Waiting for printer',
  },
  jobSourceLabels: {
    ipp: 'System',
    web: 'Web',
    reprint: 'Reprint',
    test: 'Test',
  },
  pagesShort: (n: number) => `${n} pages`,
  genericError: 'error',

  // Machine-readable error codes returned by the backend. Unknown strings
  // (raw socket errors, pre-existing history entries) pass through untranslated.
  backendErrors: {
    too_many_requests: 'Too many print requests — try again in a moment.',
    ip_required: 'IP address is required',
    image_required: 'At least one image is required',
    name_and_ip_required: 'Name and IP address are required',
    preview_not_available: 'Preview is not available',
    job_not_available: 'The job or its data is no longer available',
    print_failed: 'print failed',
    drawer_failed: 'the drawer is not responding',
    printer_timeout: 'the printer is not responding (10 s timeout)',
    no_target_printer: 'no target printer configured',
  } as Record<string, string>,

  // Cash drawer + test receipt
  openingDrawer: 'Opening the cash drawer…',
  drawerOpened: 'Cash drawer opened ✓',
  drawerFailed: (error: string) => `Failed to open the drawer: ${error}`,
  drawerFailedPlain: 'Failed to open the drawer',
  sendingTest: (ip: string) => `Sending a test receipt to ${ip}…`,
  testSent: (ip: string) => `Test receipt sent to ${ip} ✓`,
  testFailed: (ip: string, error: string) => `Printing to ${ip} failed: ${error}`,
  testSendError: (ip: string) => `Failed to send the test to ${ip}`,

  // Settings
  settingsSummary: 'Print settings',
  paperWidth: 'Paper width',
  paperWidth80: '80 mm (576 dots)',
  paperWidth58: '58 mm (384 dots)',
  cutAfterPrint: 'Cut after print',
  dithering: 'Dithering',
  brightness: 'Brightness',
  contrast: 'Contrast',
  openDrawerButton: 'Open cash drawer',

  // Queue + job history
  queueHeading: 'Queue',
  recentJobs: 'Recent jobs',
  refresh: 'Refresh',
  showPrintPreview: 'Show print preview',
  printAgain: 'Print again',
  retry: 'Retry',
  printPreviewAlt: 'Print preview',
  downloadPreviewTitle: 'Download preview (PNG)',
  downloadPreview: 'Download preview',
  close: 'Close',
  justNow: 'just now',
  momentAgo: 'a moment ago',
  minutesAgo: (m: number) => `${m} min ago`,

  // Printers section
  printersHeading: 'Printers',
  searching: 'Searching…',
  search: '↻ Search',
  noPrintersYet: 'No printers yet — add one below.',
  defaultPrinterTitle: 'Default printer (Cmd/Ctrl+P and web printing)',
  setAsDefault: 'Set as default',
  defaultPrinterAria: 'Default printer',
  online: 'Online',
  offline: 'Offline',
  defaultBadge: 'default',
  renameTitle: 'Rename',
  renameAria: (name: string) => `Rename ${name}`,
  printTestTitle: 'Print a test receipt',
  testAria: (ip: string) => `Test ${ip}`,
  removeAria: (name: string) => `Remove ${name}`,
  addPrinter: 'Add printer',
  thermalPrinterFallbackName: 'Thermal printer',
  namePlaceholder: 'Name',
  ipPlaceholder: 'IP address',
  portPlaceholder: 'Port (9100)',
  add: 'Add',
}

export const lang: Lang = detectLang()
export const t: Messages = lang === 'cs' ? cs : en

/** Translate a backend error (a machine code or a raw message) for display. */
export function translateBackendError(error: string): string {
  return t.backendErrors[error] ?? error
}
