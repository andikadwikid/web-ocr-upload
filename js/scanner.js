import { createConfirmer } from './lib.js';

const FRAME_MAX_SIDE = 1600; // sisi terpanjang frame yang dikirim ke server
const JPEG_QUALITY = 0.85;
const CONFIRM_FRAMES = 2; // nomor harus valid pada sekian frame berurutan
const PAUSE_MS = 120; // jeda antar-frame (selain waktu tunggu server)
const RETRY_MS = 2000;
const HOLD_MS = 2500; // lama pesan konfirmasi ditampilkan
const EMPTY_FRAMES_BEFORE_HINT = 5; // frame kosong berturut-turut sebelum menyarankan mendekatkan kartu

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cameraErrorText(err) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return 'Kamera hanya bisa dipakai lewat HTTPS atau http://localhost. Buka aplikasi lewat alamat tersebut.';
  }
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Izin kamera ditolak. Izinkan akses kamera untuk situs ini di pengaturan browser, lalu buka lagi.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Kamera tidak ditemukan. Sambungkan webcam lalu coba lagi.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Kamera tidak bisa dibuka; mungkin sedang dipakai aplikasi lain.';
    default:
      return `Gagal membuka kamera: ${err?.message ?? err}`;
  }
}

/**
 * Pemindai kartu lewat webcam.
 *
 * @param {object} deps
 * @param {object} deps.ui                elemen dialog (dialog, video, status, flash, auto, camera, snap, done, close, found)
 * @param {(blob: Blob) => Promise<{numbers: object[]}>} deps.recognizeFrame  OCR cepat untuk satu frame
 * @param {(blob: Blob, data: object, number: object) => void} deps.onConfirmed  nomor baru terkonfirmasi
 * @param {(blob: Blob) => void} deps.onSnap       foto manual diambil
 * @param {(digits: string) => boolean} deps.isDuplicate  nomor sudah ada di daftar?
 * @param {() => boolean} deps.autoAllowed          pemindaian otomatis berlaku (mode nomor kartu)?
 */
export function createScanner({ ui, recognizeFrame, onConfirmed, onSnap, isDuplicate, autoAllowed }) {
  const confirmer = createConfirmer(CONFIRM_FRAMES);
  const seen = new Set();
  const canvas = document.createElement('canvas');
  let stream = null;
  let loopToken = 0;
  let audio = null;
  let emptyFrames = 0;

  let holdUntil = 0;

  /** `holdMs`: pesan konfirmasi ditahan agar tidak langsung tertimpa status pemindaian berikutnya. */
  function setStatus(text, kind = '', holdMs = 0) {
    ui.status.textContent = text;
    ui.status.dataset.kind = kind;
    holdUntil = holdMs ? performance.now() + holdMs : 0;
  }

  function setLiveStatus(text, kind = '') {
    if (performance.now() >= holdUntil) setStatus(text, kind);
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    ui.video.srcObject = null;
  }

  async function listCameras(activeId) {
    let cams = [];
    try {
      cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      /* tidak penting */
    }
    ui.camera.replaceChildren(...cams.map((d, i) => {
      const opt = new Option(d.label || `Kamera ${i + 1}`, d.deviceId);
      opt.selected = d.deviceId === activeId;
      return opt;
    }));
    ui.camera.hidden = cams.length < 2;
  }

  async function startCamera(deviceId) {
    stopCamera();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: 'environment' };

    const opened = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    if (!ui.dialog.open) { // ditutup selagi menunggu izin
      opened.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = opened;
    ui.video.srcObject = stream;
    await ui.video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {
      /* tidak semua kamera mendukung fokus kontinu */
    }
    await listCameras(track.getSettings().deviceId);
  }

  function frameBlob() {
    const v = ui.video;
    if (!v.videoWidth) return Promise.resolve(null);
    const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  }

  function feedback() {
    ui.flash.classList.remove('on');
    void ui.flash.offsetWidth; // mulai ulang animasi
    ui.flash.classList.add('on');
    navigator.vibrate?.(60);
    try {
      if (!audio) return;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.12);
    } catch {
      /* suara hanya pelengkap */
    }
  }

  function handleFrame(blob, data) {
    const numbers = data.numbers ?? [];
    const good = numbers.filter((n) => n.length_ok && n.luhn !== false);
    const bad = numbers.filter((n) => n.length_ok && n.luhn === false);
    const known = good.filter((n) => seen.has(n.digits) || isDuplicate(n.digits));
    const fresh = good.filter((n) => !known.includes(n));

    for (const digits of confirmer.push(fresh.map((n) => n.digits))) {
      const number = fresh.find((n) => n.digits === digits);
      seen.add(digits);
      onConfirmed(blob, data, number);
      const li = document.createElement('li');
      li.textContent = number.value;
      ui.found.prepend(li);
      feedback();
      setStatus(`✓ ${number.value} ditambahkan. Ganti ke kartu berikutnya.`, 'ok', HOLD_MS);
      return;
    }
    emptyFrames = numbers.length ? 0 : emptyFrames + 1;
    if (fresh.length) setLiveStatus(`Memverifikasi ${fresh[0].value}…`);
    else if (known.length) setLiveStatus(`${known[0].value} sudah ada di daftar. Ganti ke kartu berikutnya.`, 'ok');
    else if (bad.length) setLiveStatus(`Terbaca ${bad[0].value} tetapi checksum tidak cocok. Tahan kartu lebih stabil dan kurangi silau.`, 'warn');
    else if (emptyFrames >= EMPTY_FRAMES_BEFORE_HINT) {
      setLiveStatus('Nomor belum terbaca. Dekatkan kartu sampai memenuhi bingkai putus-putus dan tahan stabil.', 'warn');
    } else setLiveStatus('Letakkan kartu di dalam bingkai…');
  }

  async function loop(token) {
    while (token === loopToken) {
      if (!ui.auto.checked || !autoAllowed()) {
        if (ui.auto.checked) setLiveStatus('Pindai otomatis hanya untuk mode "Nomor kartu". Gunakan Ambil foto.', 'warn');
        await sleep(400);
        continue;
      }
      const blob = await frameBlob();
      if (!blob) { await sleep(200); continue; }
      try {
        const data = await recognizeFrame(blob);
        if (token !== loopToken) return;
        handleFrame(blob, data);
      } catch (err) {
        if (token !== loopToken) return;
        setLiveStatus(`${err?.message ?? err}. Mencoba lagi…`, 'error');
        await sleep(RETRY_MS);
      }
      await sleep(PAUSE_MS);
    }
  }

  async function open() {
    seen.clear();
    confirmer.reset();
    emptyFrames = 0;
    ui.found.replaceChildren();
    ui.dialog.showModal();
    setStatus('Mengaktifkan kamera…');
    try {
      audio ??= new AudioContext(); // dibuat dari gestur pengguna agar tidak diblokir autoplay
    } catch {
      audio = null;
    }
    try {
      await startCamera();
    } catch (err) {
      setStatus(cameraErrorText(err), 'error');
      return;
    }
    if (!ui.dialog.open) return;
    setLiveStatus('Letakkan kartu di dalam bingkai…');
    loopToken++;
    loop(loopToken);
  }

  function close() {
    if (ui.dialog.open) ui.dialog.close();
  }

  ui.dialog.addEventListener('close', () => { // juga dipicu oleh tombol Esc
    loopToken++;
    stopCamera();
  });
  ui.close.addEventListener('click', close);
  ui.done.addEventListener('click', close);

  ui.camera.addEventListener('change', async () => {
    loopToken++;
    try {
      await startCamera(ui.camera.value);
      loopToken++;
      loop(loopToken);
    } catch (err) {
      setStatus(cameraErrorText(err), 'error');
    }
  });

  ui.snap.addEventListener('click', async () => {
    const blob = await frameBlob();
    if (!blob) { setStatus('Kamera belum siap.', 'warn'); return; }
    onSnap(blob);
    ui.flash.classList.remove('on');
    void ui.flash.offsetWidth;
    ui.flash.classList.add('on');
    setStatus('Foto diambil dan dimasukkan ke daftar untuk diproses.', 'ok', HOLD_MS);
  });

  /** Pesan dari luar (mis. hasil salin/unduh) pada baris status dialog. */
  function say(text, kind = '') {
    setStatus(text, kind, HOLD_MS);
  }

  return { open, close, say };
}
