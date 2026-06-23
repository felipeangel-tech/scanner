/* Scan2PDF — camera capture, image enhancement, PDF export, Web Share */
(() => {
  const { jsPDF } = window.jspdf;

  // --- DOM ---
  const video = document.getElementById('video');
  const work = document.getElementById('work');
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const cameraView = document.getElementById('cameraView');
  const reviewView = document.getElementById('reviewView');
  const pagesEl = document.getElementById('pages');
  const pageCount = document.getElementById('pageCount');
  const toastEl = document.getElementById('toast');

  const shutterBtn = document.getElementById('shutterBtn');
  const filterBtn = document.getElementById('filterBtn');
  const fileInput = document.getElementById('fileInput');
  const reviewBtn = document.getElementById('reviewBtn');
  const backBtn = document.getElementById('backBtn');
  const exportBtn = document.getElementById('exportBtn');
  const shareBtn = document.getElementById('shareBtn');

  // --- State ---
  // pages: { dataUrl, rotation }
  const pages = [];
  const FILTERS = ['Auto', 'Gray', 'B&W', 'Color'];
  let filterIdx = 0;
  let stream = null;

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
      console.error(err);
    }
  }

  // ---------- Image enhancement ----------
  function enhance(imageData, mode) {
    const d = imageData.data;
    if (mode === 'Color') return imageData;

    // grayscale + contrast/brightness tuned for documents
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (mode === 'Gray' || mode === 'Auto') {
        // boost contrast, lift whites
        g = (g - 128) * 1.35 + 128 + 18;
      }
      if (mode === 'B&W') {
        g = g > 145 ? 255 : 0;
      }
      g = Math.max(0, Math.min(255, g));
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    return imageData;
  }

  function drawToWork(source, sw, sh) {
    work.width = sw;
    work.height = sh;
    ctx.drawImage(source, 0, 0, sw, sh);
    const mode = FILTERS[filterIdx];
    if (mode !== 'Color') {
      const id = ctx.getImageData(0, 0, sw, sh);
      ctx.putImageData(enhance(id, mode), 0, 0);
    }
    return work.toDataURL('image/jpeg', 0.85);
  }

  function capture() {
    if (!video.videoWidth) { toast('Camera not ready.'); return; }
    flash();
    const dataUrl = drawToWork(video, video.videoWidth, video.videoHeight);
    pages.push({ dataUrl, rotation: 0 });
    updateUI();
  }

  function importFiles(files) {
    let pending = files.length;
    [...files].forEach(file => {
      const img = new Image();
      img.onload = () => {
        const dataUrl = drawToWork(img, img.naturalWidth, img.naturalHeight);
        pages.push({ dataUrl, rotation: 0 });
        if (--pending === 0) updateUI();
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
    if (e.target.classList.contains('del')) {
      pages.splice(+i, 1);
      updateUI();
    } else if (e.target.classList.contains('rot')) {
      pages[+i].rotation = (pages[+i].rotation + 90) % 360;
      renderPages();
    }
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
      const w = dims.w * ratio;
      const h = dims.h * ratio;
      const x = (pw - w) / 2;
      const y = (ph - h) / 2;
      if (i > 0) pdf.addPage();
      pdf.addImage(url, 'JPEG', x, y, w, h, undefined, 'FAST');
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
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `Scan_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`;
  }

  async function exportPDF() {
    if (!pages.length) return;
    toast('Building PDF…');
    const pdf = await buildPDF();
    pdf.save(fileName());
  }

  async function sharePDF() {
    if (!pages.length) return;
    toast('Preparing to share…');
    const pdf = await buildPDF();
    const blob = pdf.output('blob');
    const file = new File([blob], fileName(), { type: 'application/pdf' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Scanned Document' });
      } catch (err) {
        if (err.name !== 'AbortError') toast('Share cancelled.');
      }
    } else {
      // fallback: download
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
