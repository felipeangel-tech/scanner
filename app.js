/* Scan2PDF — camera capture, page edge detection + perspective crop,
   multi-page review, persistence, PDF export & share */
(() => {
  const { jsPDF } = window.jspdf;
  const $ = id => document.getElementById(id);

  // --- DOM ---
  const video = $('video');
  const overlay = $('overlay'), octx = overlay.getContext('2d');
  const work = $('work'), ctx = work.getContext('2d', { willReadFrequently: true });
  const det = $('detect'), dctx = det.getContext('2d', { willReadFrequently: true });
  const cameraView = $('cameraView'), reviewView = $('reviewView');
  const pagesEl = $('pages'), toastEl = $('toast');
  const hint = $('hint'), hintText = $('hintText'), hintSpinner = $('hintSpinner');

  const shutterBtn = $('shutterBtn'), filterBtn = $('filterBtn'), cropBtn = $('cropBtn');
  const torchBtn = $('torchBtn'), fileInput = $('fileInput');
  const reviewBtn = $('reviewBtn'), reviewFabCount = $('reviewFabCount');
  const backBtn = $('backBtn'), clearBtn = $('clearBtn'), docName = $('docName');
  const exportBtn = $('exportBtn'), shareBtn = $('shareBtn');
  const formatSel = $('formatSel'), reviewCount = $('reviewCount');
  const viewer = $('viewer'), viewerImg = $('viewerImg'), viewerLabel = $('viewerLabel');
  const viewerPrev = $('viewerPrev'), viewerNext = $('viewerNext'), viewerClose = $('viewerClose');
  const viewerRotate = $('viewerRotate'), viewerDelete = $('viewerDelete');

  // --- State ---
  let pages = [];                       // { dataUrl, rotation }
  const FILTERS = ['Auto', 'Gray', 'B&W', 'Color'];
  let filterIdx = 0, cropEnabled = true, pdfFormat = 'auto';
  let cvReady = false, scanner = null, stream = null, track = null, torchOn = false;
  let viewerIdx = -1;

  // ---------- Persistence (IndexedDB) ----------
  const DB = 'scan2pdf', STORE = 'state';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function dbSet(key, val) {
    try { const d = await db(); await new Promise((res, rej) => { const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) {}
  }
  async function dbGet(key) {
    try { const d = await db(); return await new Promise(res => { const tx = d.transaction(STORE, 'readonly'); const rq = tx.objectStore(STORE).get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(undefined); }); } catch (e) { return undefined; }
  }

  let saveTimer;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      dbSet('pages', pages);
      dbSet('settings', { filterIdx, cropEnabled, pdfFormat, docName: docName.value });
    }, 250);
  }

  async function restore() {
    const saved = await dbGet('pages');
    const s = await dbGet('settings');
    if (s) {
      filterIdx = s.filterIdx ?? 0; filterBtn.textContent = FILTERS[filterIdx];
      cropEnabled = s.cropEnabled ?? true; applyCropBtn();
      pdfFormat = s.pdfFormat ?? 'auto'; formatSel.value = pdfFormat;
      if (s.docName) docName.value = s.docName;
    }
    if (Array.isArray(saved) && saved.length) {
      pages = saved;
      updateUI();
      toast(`Restored ${saved.length} page${saved.length === 1 ? '' : 's'}`);
    }
  }

  // ---------- OpenCV / jscanify readiness ----------
  function whenCvReady(cb) {
    const ok = () => window.cv && window.cv.Mat && window.jscanify;
    if (ok()) return cb();
    const t = setInterval(() => { if (ok()) { clearInterval(t); cb(); } }, 120);
  }
  whenCvReady(() => {
    cvReady = true;
    scanner = new window.jscanify();
    setHint('Point at a document', false);
    detectLoop();
  });

  function setHint(text, spinning) {
    hintText.textContent = text;
    hintSpinner.hidden = !spinning;
  }

  // ---------- Camera ----------
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps && caps.torch) torchBtn.hidden = false;
      if (!cvReady) setHint('Preparing scanner…', true);
    } catch (err) {
      setHint('Camera unavailable — use ＋ to import', false);
      toast('Camera unavailable — use ＋ to import images.');
      console.error(err);
    }
  }

  async function toggleTorch() {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); torchBtn.style.opacity = torchOn ? 1 : .6; }
    catch (e) { toast('Flash not supported.'); }
  }

  // ---------- Edge detection ----------
  function detectCorners(canvas) {
    let mat = null, contour = null;
    try {
      mat = window.cv.imread(canvas);
      contour = scanner.findPaperContour(mat);
      if (!contour) return null;
      const c = scanner.getCornerPoints(contour);
      const k = ['topLeftCorner', 'topRightCorner', 'bottomLeftCorner', 'bottomRightCorner'];
      if (k.some(n => !c[n])) return null;
      const out = {};
      k.forEach(n => (out[n] = { x: c[n].x, y: c[n].y }));
      return out;
    } catch (e) { return null; }
    finally { if (contour) contour.delete(); if (mat) mat.delete(); }
  }
  function quadArea(c) {
    const p = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
    let a = 0;
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a += p[i].x * p[j].y - p[j].x * p[i].y; }
    return Math.abs(a) / 2;
  }
  function outputDims(c) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return {
      w: Math.round(Math.max(d(c.topLeftCorner, c.topRightCorner), d(c.bottomLeftCorner, c.bottomRightCorner))),
      h: Math.round(Math.max(d(c.topLeftCorner, c.bottomLeftCorner), d(c.topRightCorner, c.bottomRightCorner)))
    };
  }

  let lastCorners = null;
  function detectLoop() {
    // Only run detection while the camera view is on screen — saves CPU/battery.
    if (cameraView.hidden) { setTimeout(detectLoop, 400); return; }
    try {
      if (cropEnabled && cvReady && video.videoWidth) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (overlay.width !== vw) { overlay.width = vw; overlay.height = vh; }
        const scale = 480 / Math.max(vw, vh);
        det.width = Math.round(vw * scale);
        det.height = Math.round(vh * scale);
        dctx.drawImage(video, 0, 0, det.width, det.height);
        const c = detectCorners(det);
        lastCorners = c && quadArea(c) > det.width * det.height * 0.12 ? c : null;
        drawOverlay(lastCorners, 1 / scale);
        hint.classList.toggle('found', !!lastCorners);
        setHint(lastCorners ? 'Page detected ✓' : 'Searching for page…', false);
      } else {
        octx.clearRect(0, 0, overlay.width, overlay.height);
      }
    } catch (e) {}
    setTimeout(detectLoop, 140);
  }
  function drawOverlay(c, up) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!c) return;
    const p = k => [c[k].x * up, c[k].y * up];
    const pts = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'].map(p);
    octx.lineWidth = Math.max(4, overlay.width * 0.006);
    octx.lineJoin = 'round';
    octx.strokeStyle = '#2dd4bf';
    octx.fillStyle = 'rgba(45,212,191,0.16)';
    octx.beginPath();
    octx.moveTo(...pts[0]);
    pts.slice(1).forEach(pt => octx.lineTo(...pt));
    octx.closePath(); octx.fill(); octx.stroke();
    // corner dots
    octx.fillStyle = '#2dd4bf';
    const r = Math.max(7, overlay.width * 0.011);
    pts.forEach(pt => { octx.beginPath(); octx.arc(pt[0], pt[1], r, 0, 7); octx.fill(); });
  }

  // ---------- Enhancement + processing ----------
  function enhance(imageData, mode) {
    const d = imageData.data;
    if (mode === 'Color') return imageData;
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (mode === 'Gray' || mode === 'Auto') g = (g - 128) * 1.35 + 128 + 18;
      if (mode === 'B&W') g = g > 145 ? 255 : 0;
      g = Math.max(0, Math.min(255, g));
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    return imageData;
  }
  function process(source, sw, sh) {
    work.width = sw; work.height = sh;
    ctx.drawImage(source, 0, 0, sw, sh);
    let outCanvas = work, outCtx = ctx, cropped = false;
    if (cropEnabled && cvReady && scanner) {
      const corners = detectCorners(work);
      if (corners && quadArea(corners) > sw * sh * 0.10) {
        const { w, h } = outputDims(corners);
        if (w > 40 && h > 40) {
          const cc = scanner.extractPaper(work, w, h, corners);
          if (cc) { outCanvas = cc; outCtx = cc.getContext('2d'); cropped = true; }
        }
      }
    }
    const mode = FILTERS[filterIdx];
    if (mode !== 'Color') {
      const id = outCtx.getImageData(0, 0, outCanvas.width, outCanvas.height);
      outCtx.putImageData(enhance(id, mode), 0, 0);
    }
    return { dataUrl: outCanvas.toDataURL('image/jpeg', 0.85), cropped };
  }

  function capture() {
    if (!video.videoWidth) { toast('Camera not ready.'); return; }
    flash();
    if (navigator.vibrate) navigator.vibrate(12);
    const r = process(video, video.videoWidth, video.videoHeight);
    pages.push({ dataUrl: r.dataUrl, rotation: 0 });
    if (cropEnabled) toast(r.cropped ? 'Page cropped ✓' : 'No page found — full frame');
    changed();
  }
  function importFiles(files) {
    let pending = files.length;
    if (!pending) return;
    toast(`Importing ${pending} image${pending === 1 ? '' : 's'}…`);
    [...files].forEach(file => {
      const img = new Image();
      img.onload = () => {
        const r = process(img, img.naturalWidth, img.naturalHeight);
        pages.push({ dataUrl: r.dataUrl, rotation: 0 });
        URL.revokeObjectURL(img.src);
        if (--pending === 0) changed();
      };
      img.onerror = () => { if (--pending === 0) changed(); };
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------- UI ----------
  function changed() { updateUI(); persist(); }
  function updateUI() {
    const n = pages.length;
    reviewBtn.hidden = n === 0;
    reviewFabCount.textContent = n;
    reviewCount.textContent = n + (n === 1 ? ' page' : ' pages');
    if (!reviewView.hidden) renderPages();
  }
  function renderPages() {
    pagesEl.innerHTML = '';
    if (!pages.length) {
      pagesEl.innerHTML = '<div class="empty">No pages yet.<br>Tap ← to scan or import.</div>';
      return;
    }
    pages.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'page-card';
      card.innerHTML = `
        <img src="${p.dataUrl}" data-view="${i}" style="transform:rotate(${p.rotation}deg)" />
        <span class="num">${i + 1}</span>
        <button class="del" data-del="${i}" aria-label="Delete">✕</button>
        <button class="rot" data-rot="${i}" aria-label="Rotate">⟳</button>
        <button class="mv-l" data-mv="${i}" data-dir="-1" aria-label="Move earlier" ${i === 0 ? 'disabled' : ''}>‹</button>
        <button class="mv-r" data-mv="${i}" data-dir="1" aria-label="Move later" ${i === pages.length - 1 ? 'disabled' : ''}>›</button>`;
      pagesEl.appendChild(card);
    });
  }
  pagesEl.addEventListener('click', e => {
    const t = e.target;
    if (t.dataset.del !== undefined) { pages.splice(+t.dataset.del, 1); changed(); }
    else if (t.dataset.rot !== undefined) { const i = +t.dataset.rot; pages[i].rotation = (pages[i].rotation + 90) % 360; renderPages(); persist(); }
    else if (t.dataset.mv !== undefined) { move(+t.dataset.mv, +t.dataset.dir); }
    else if (t.dataset.view !== undefined) { openViewer(+t.dataset.view); }
  });
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    renderPages(); persist();
  }

  function applyCropBtn() {
    cropBtn.textContent = cropEnabled ? 'Edges' : 'No crop';
    cropBtn.classList.toggle('off', !cropEnabled);
  }

  function showCamera() { cameraView.hidden = false; reviewView.hidden = true; }
  function showReview() { cameraView.hidden = true; reviewView.hidden = false; renderPages(); }

  // ---------- Fullscreen viewer ----------
  function openViewer(i) { viewerIdx = i; viewer.hidden = false; renderViewer(); }
  function closeViewer() { viewer.hidden = true; viewerIdx = -1; }
  function renderViewer() {
    if (viewerIdx < 0 || !pages.length) return closeViewer();
    const p = pages[viewerIdx];
    viewerImg.src = p.dataUrl;
    viewerImg.style.transform = `rotate(${p.rotation}deg)`;
    viewerLabel.textContent = `${viewerIdx + 1} / ${pages.length}`;
    viewerPrev.disabled = viewerIdx === 0;
    viewerNext.disabled = viewerIdx === pages.length - 1;
  }
  viewerClose.addEventListener('click', closeViewer);
  viewerPrev.addEventListener('click', () => { if (viewerIdx > 0) { viewerIdx--; renderViewer(); } });
  viewerNext.addEventListener('click', () => { if (viewerIdx < pages.length - 1) { viewerIdx++; renderViewer(); } });
  viewerRotate.addEventListener('click', () => { pages[viewerIdx].rotation = (pages[viewerIdx].rotation + 90) % 360; renderViewer(); renderPages(); persist(); });
  viewerDelete.addEventListener('click', () => {
    pages.splice(viewerIdx, 1);
    if (!pages.length) { closeViewer(); changed(); return; }
    if (viewerIdx >= pages.length) viewerIdx = pages.length - 1;
    renderViewer(); changed();
  });

  // ---------- PDF ----------
  function rotatedDataUrl(p) {
    return new Promise(resolve => {
      if (!p.rotation) return resolve(p.dataUrl);
      const img = new Image();
      img.onload = () => {
        const swap = p.rotation % 180 !== 0;
        work.width = swap ? img.height : img.width;
        work.height = swap ? img.width : img.height;
        ctx.save();
        ctx.translate(work.width / 2, work.height / 2);
        ctx.rotate(p.rotation * Math.PI / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        ctx.restore();
        resolve(work.toDataURL('image/jpeg', 0.85));
      };
      img.src = p.dataUrl;
    });
  }
  function imgDims(url) {
    return new Promise(res => { const img = new Image(); img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight }); img.src = url; });
  }
  async function buildPDF() {
    let pdf = null;
    for (let i = 0; i < pages.length; i++) {
      const url = await rotatedDataUrl(pages[i]);
      const dm = await imgDims(url);
      const aspect = dm.w / dm.h;
      let pw, ph, dw, dh, x, y;
      if (pdfFormat === 'auto') {
        pw = 595.28; ph = pw / aspect; dw = pw; dh = ph; x = 0; y = 0;
      } else {
        const sz = pdfFormat === 'letter' ? [612, 792] : [595.28, 841.89];
        pw = sz[0]; ph = sz[1];
        const r = Math.min(pw / dm.w, ph / dm.h);
        dw = dm.w * r; dh = dm.h * r; x = (pw - dw) / 2; y = (ph - dh) / 2;
      }
      if (i === 0) pdf = new jsPDF({ unit: 'pt', format: [pw, ph], compress: true });
      else pdf.addPage([pw, ph]);
      pdf.addImage(url, 'JPEG', x, y, dw, dh, undefined, 'FAST');
    }
    return pdf;
  }
  function fileName() {
    const base = (docName.value || '').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_');
    if (base) return base + '.pdf';
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `Scan_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`;
  }
  async function exportPDF() {
    if (!pages.length) return;
    toast('Building PDF…');
    (await buildPDF()).save(fileName());
  }
  async function sharePDF() {
    if (!pages.length) return;
    toast('Preparing to share…');
    const pdf = await buildPDF();
    const file = new File([pdf.output('blob')], fileName(), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: docName.value || 'Scanned Document' }); }
      catch (err) { if (err.name !== 'AbortError') toast('Share cancelled.'); }
    } else { pdf.save(fileName()); toast('Sharing not supported — saved instead.'); }
  }

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.hidden = true), 2200);
  }
  function flash() {
    const f = document.createElement('div'); f.className = 'flash';
    document.body.appendChild(f); setTimeout(() => f.remove(), 260);
  }

  // ---------- events ----------
  shutterBtn.addEventListener('click', capture);
  filterBtn.addEventListener('click', () => { filterIdx = (filterIdx + 1) % FILTERS.length; filterBtn.textContent = FILTERS[filterIdx]; persist(); });
  cropBtn.addEventListener('click', () => { cropEnabled = !cropEnabled; applyCropBtn(); if (!cropEnabled) octx.clearRect(0, 0, overlay.width, overlay.height); persist(); });
  torchBtn.addEventListener('click', toggleTorch);
  fileInput.addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
  reviewBtn.addEventListener('click', showReview);
  backBtn.addEventListener('click', showCamera);
  clearBtn.addEventListener('click', () => {
    if (!pages.length) return;
    if (confirm(`Delete all ${pages.length} page(s)?`)) { pages = []; changed(); }
  });
  docName.addEventListener('input', persist);
  formatSel.addEventListener('change', () => { pdfFormat = formatSel.value; persist(); });
  exportBtn.addEventListener('click', exportPDF);
  shareBtn.addEventListener('click', sharePDF);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !viewer.hidden) closeViewer(); });

  // ---------- init ----------
  applyCropBtn();
  updateUI();
  restore();
  startCamera();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
  }
})();
