/* Scan2PDF — camera capture, page edge detection + perspective crop, PDF export, share */
(() => {
  const { jsPDF } = window.jspdf;

  // --- DOM ---
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const octx = overlay.getContext('2d');
  const work = document.getElementById('work');
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const det = document.getElementById('detect');
  const dctx = det.getContext('2d', { willReadFrequently: true });
  const cameraView = document.getElementById('cameraView');
  const reviewView = document.getElementById('reviewView');
  const pagesEl = document.getElementById('pages');
  const pageCount = document.getElementById('pageCount');
  const toastEl = document.getElementById('toast');
  const hint = document.getElementById('hint');

  const shutterBtn = document.getElementById('shutterBtn');
  const filterBtn = document.getElementById('filterBtn');
  const cropBtn = document.getElementById('cropBtn');
  const fileInput = document.getElementById('fileInput');
  const reviewBtn = document.getElementById('reviewBtn');
  const backBtn = document.getElementById('backBtn');
  const exportBtn = document.getElementById('exportBtn');
  const shareBtn = document.getElementById('shareBtn');

  // --- State ---
  const pages = [];                 // { dataUrl, rotation }
  const FILTERS = ['Auto', 'Gray', 'B&W', 'Color'];
  let filterIdx = 0;
  let cropEnabled = true;
  let cvReady = false;
  let scanner = null;
  let stream = null;

  // ---------- OpenCV / jscanify readiness ----------
  function whenCvReady(cb) {
    const ok = () => window.cv && window.cv.Mat && window.jscanify;
    if (ok()) return cb();
    const t = setInterval(() => { if (ok()) { clearInterval(t); cb(); } }, 120);
  }
  whenCvReady(() => {
    cvReady = true;
    scanner = new window.jscanify();
    hint.textContent = 'Point at a document';
    detectLoop();
  });

  // ---------- Camera ----------
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      toast('Camera unavailable — use ＋ to import images.');
      hint.textContent = 'Camera unavailable';
      console.error(err);
    }
  }

  // ---------- Edge detection ----------
  // Returns plain corner points in the source canvas's pixel space, or null.
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
    } catch (e) {
      return null;
    } finally {
      if (contour) contour.delete();
      if (mat) mat.delete();
    }
  }

  function quadArea(c) {
    const p = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      a += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return Math.abs(a) / 2;
  }

  function outputDims(c) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const w = Math.round(Math.max(d(c.topLeftCorner, c.topRightCorner), d(c.bottomLeftCorner, c.bottomRightCorner)));
    const h = Math.round(Math.max(d(c.topLeftCorner, c.bottomLeftCorner), d(c.topRightCorner, c.bottomRightCorner)));
    return { w, h };
  }

  // Live overlay loop — throttled, downscaled detection
  let lastCorners = null;
  function detectLoop() {
    try {
      if (cropEnabled && cvReady && video.videoWidth) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (overlay.width !== vw) { overlay.width = vw; overlay.height = vh; }
        const scale = 480 / Math.max(vw, vh);
        det.width = Math.round(vw * scale);
        det.height = Math.round(vh * scale);
        dctx.drawImage(video, 0, 0, det.width, det.height);
        const c = detectCorners(det);
        const minArea = det.width * det.height * 0.12;
        lastCorners = c && quadArea(c) > minArea ? c : null;
        drawOverlay(lastCorners, 1 / scale);
        hint.textContent = lastCorners ? 'Page detected ✓' : 'Searching for page…';
      } else {
        octx.clearRect(0, 0, overlay.width, overlay.height);
      }
    } catch (e) { /* keep looping */ }
    setTimeout(() => requestAnimationFrame(detectLoop), 140);
  }

  function drawOverlay(c, up) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!c) return;
    const p = k => [c[k].x * up, c[k].y * up];
    octx.lineWidth = Math.max(4, overlay.width * 0.006);
    octx.lineJoin = 'round';
    octx.strokeStyle = '#2dd4bf';
    octx.fillStyle = 'rgba(45,212,191,0.18)';
    octx.beginPath();
    octx.moveTo(...p('topLeftCorner'));
    octx.lineTo(...p('topRightCorner'));
    octx.lineTo(...p('bottomRightCorner'));
    octx.lineTo(...p('bottomLeftCorner'));
    octx.closePath();
    octx.fill();
    octx.stroke();
  }

  // ---------- Image enhancement ----------
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

  // Draw source -> work, optionally crop to detected page, then apply filter.
  function process(source, sw, sh) {
    work.width = sw;
    work.height = sh;
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
    const r = process(video, video.videoWidth, video.videoHeight);
    pages.push({ dataUrl: r.dataUrl, rotation: 0 });
    if (cropEnabled) toast(r.cropped ? 'Page cropped ✓' : 'No page found — full frame');
    updateUI();
  }

  function importFiles(files) {
    let pending = files.length;
    [...files].forEach(file => {
      const img = new Image();
      img.onload = () => {
        const r = process(img, img.naturalWidth, img.naturalHeight);
        pages.push({ dataUrl: r.dataUrl, rotation: 0 });
        if (--pending === 0) updateUI();
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => { if (--pending === 0) updateUI(); };
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------- UI ----------
  function updateUI() {
    const n = pages.length;
    pageCount.textContent = n + (n === 1 ? ' page' : ' pages');
    reviewBtn.hidden = n === 0;
    renderPages();
  }

  function renderPages() {
    pagesEl.innerHTML = '';
    if (pages.length === 0) {
      pagesEl.innerHTML = '<div class="empty">No pages yet.<br>Scan or import to begin.</div>';
      return;
    }
    pages.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'page-card';
      card.innerHTML = `
        <img src="${p.dataUrl}" style="transform:rotate(${p.rotation}deg)" />
        <span class="num">${i + 1}</span>
        <button class="del" data-i="${i}" aria-label="Delete">✕</button>
        <button class="rot" data-i="${i}" aria-label="Rotate">⟳</button>`;
      pagesEl.appendChild(card);
    });
  }

  pagesEl.addEventListener('click', e => {
    const i = e.target.dataset.i;
    if (i === undefined) return;
    if (e.target.classList.contains('del')) { pages.splice(+i, 1); updateUI(); }
    else if (e.target.classList.contains('rot')) { pages[+i].rotation = (pages[+i].rotation + 90) % 360; renderPages(); }
  });

  function showCamera() { cameraView.hidden = false; reviewView.hidden = true; }
  function showReview() { cameraView.hidden = true; reviewView.hidden = false; renderPages(); }

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

  async function buildPDF() {
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    for (let i = 0; i < pages.length; i++) {
      const url = await rotatedDataUrl(pages[i]);
      const dims = await imgDims(url);
      const ratio = Math.min(pw / dims.w, ph / dims.h);
      const w = dims.w * ratio, h = dims.h * ratio;
      if (i > 0) pdf.addPage();
      pdf.addImage(url, 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
    }
    return pdf;
  }

  function imgDims(url) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.src = url;
    });
  }

  function fileName() {
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
    const blob = pdf.output('blob');
    const file = new File([blob], fileName(), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Scanned Document' }); }
      catch (err) { if (err.name !== 'AbortError') toast('Share cancelled.'); }
    } else {
      pdf.save(fileName());
      toast('Sharing not supported — saved instead.');
    }
  }

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2200);
  }
  function flash() {
    const f = document.createElement('div');
    f.className = 'flash';
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 260);
  }

  // ---------- events ----------
  shutterBtn.addEventListener('click', capture);
  filterBtn.addEventListener('click', () => {
    filterIdx = (filterIdx + 1) % FILTERS.length;
    filterBtn.textContent = FILTERS[filterIdx];
  });
  cropBtn.addEventListener('click', () => {
    cropEnabled = !cropEnabled;
    cropBtn.textContent = cropEnabled ? 'Edges' : 'No crop';
    cropBtn.classList.toggle('off', !cropEnabled);
    if (!cropEnabled) octx.clearRect(0, 0, overlay.width, overlay.height);
  });
  fileInput.addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
  reviewBtn.addEventListener('click', showReview);
  backBtn.addEventListener('click', showCamera);
  exportBtn.addEventListener('click', exportPDF);
  shareBtn.addEventListener('click', sharePDF);

  // ---------- init ----------
  updateUI();
  startCamera();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
  }
})();
