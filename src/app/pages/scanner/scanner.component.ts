import { Component, signal, ViewChild, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { createWorker, Worker, PSM } from 'tesseract.js';

interface SeriesRange { del: number; al: number; }
interface SeriesData { [key: string]: SeriesRange[]; }

type ScanStatus = 'idle' | 'loading' | 'cropping' | 'scanning' | 'confirming' | 'done' | 'error';

interface Rect { x1: number; y1: number; x2: number; y2: number; }

@Component({
  selector: 'app-scanner',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scanner.component.html',
  styleUrl: './scanner.component.scss'
})
export class ScannerComponent implements OnInit, OnDestroy {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('galleryInput') galleryInput!: ElementRef<HTMLInputElement>;
  @ViewChild('cropCanvas') cropCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('cropImg')    cropImgRef!: ElementRef<HTMLImageElement>;

  status           = signal<ScanStatus>('idle');
  progress         = signal<number>(0);
  progressMsg      = signal<string>('Iniciando...');
  imagePreview     = signal<string | null>(null);
  isValid          = signal<boolean | null>(null);
  detectedSerial   = signal<string | null>(null);
  detectedDenom    = signal<string | null>(null);
  errorMsg         = signal<string | null>(null);
  hasCropSelection = signal<boolean>(false);

  // Confirmation step: user can edit before verifying
  editSerialNum    = signal<string>('');
  editSerialLetter = signal<string>('');
  rawOcrText       = signal<string>('');
  allCandidates    = signal<Array<{ num: number; letter: string }>>([]);

  private seriesData: SeriesData | null = null;
  private worker: Worker | null = null;
  private workerReady = false;

  private cropDragging = false;
  private cropRect: Rect = { x1: 0, y1: 0, x2: 0, y2: 0 };
  private pendingFile: File | null = null;

  async ngOnInit() {
    await Promise.all([this.loadSeriesData(), this.initWorker()]);
  }

  private async loadSeriesData() {
    const res = await fetch('/seriesb.json');
    this.seriesData = await res.json();
  }

  private async initWorker() {
    this.worker = await createWorker('eng', 1, {
      logger: (m: any) => {
        if (m.status === 'recognizing text') this.progress.set(Math.round(m.progress * 100));
        const msgs: Record<string, string> = {
          'loading tesseract core': 'Cargando motor OCR...',
          'initializing tesseract': 'Inicializando...',
          'loading language traineddata': 'Cargando idioma...',
          'initialized tesseract': 'Motor listo',
          'recognizing text': 'Reconociendo texto...',
        };
        this.progressMsg.set(msgs[m.status] ?? m.status);
      }
    });
    await this.worker.setParameters({
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });
    this.workerReady = true;
  }

  // ── File handling ─────────────────────────────────────────────────
  triggerFileInput() { this.fileInput.nativeElement.click(); }
  triggerGalleryInput() { this.galleryInput.nativeElement.click(); }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    await this.loadForCrop(input.files[0]);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) this.loadForCrop(file);
  }

  private async loadForCrop(file: File) {
    this.pendingFile = file;
    this.resetState();
    this.status.set('loading');
    const preview = await this.readFileAsDataURL(file);
    this.imagePreview.set(preview);
    this.status.set('cropping');
    this.hasCropSelection.set(false);
    this.cropRect = { x1: 0, y1: 0, x2: 0, y2: 0 };
  }

  // ── Crop canvas ───────────────────────────────────────────────────
  onCropImgLoad() {
    const canvas = this.cropCanvasRef?.nativeElement;
    const img    = this.cropImgRef?.nativeElement;
    if (!canvas || !img) return;
    canvas.width  = img.offsetWidth;
    canvas.height = img.offsetHeight;
    this.drawCropOverlay();
  }

  onCropStart(e: MouseEvent) {
    e.preventDefault();
    const pos = this.canvasPos(e.clientX, e.clientY);
    this.cropRect = { x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
    this.cropDragging = true;
    this.hasCropSelection.set(false);
  }

  onCropMove(e: MouseEvent) {
    if (!this.cropDragging) return;
    e.preventDefault();
    const pos = this.canvasPos(e.clientX, e.clientY);
    this.cropRect.x2 = pos.x;
    this.cropRect.y2 = pos.y;
    this.drawCropOverlay();
  }

  onCropEnd(e: MouseEvent) {
    if (!this.cropDragging) return;
    this.cropDragging = false;
    const w = Math.abs(this.cropRect.x2 - this.cropRect.x1);
    const h = Math.abs(this.cropRect.y2 - this.cropRect.y1);
    this.hasCropSelection.set(w > 10 && h > 10);
    this.drawCropOverlay();
  }

  onCropTouchStart(e: TouchEvent) {
    e.preventDefault();
    const t = e.touches[0];
    const pos = this.canvasPos(t.clientX, t.clientY);
    this.cropRect = { x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
    this.cropDragging = true;
    this.hasCropSelection.set(false);
  }

  onCropTouchMove(e: TouchEvent) {
    if (!this.cropDragging) return;
    e.preventDefault();
    const t = e.touches[0];
    const pos = this.canvasPos(t.clientX, t.clientY);
    this.cropRect.x2 = pos.x;
    this.cropRect.y2 = pos.y;
    this.drawCropOverlay();
  }

  onCropTouchEnd(e: TouchEvent) {
    if (!this.cropDragging) return;
    this.cropDragging = false;
    const w = Math.abs(this.cropRect.x2 - this.cropRect.x1);
    const h = Math.abs(this.cropRect.y2 - this.cropRect.y1);
    this.hasCropSelection.set(w > 10 && h > 10);
    this.drawCropOverlay();
  }

  private canvasPos(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.cropCanvasRef.nativeElement;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.min(canvas.width,  Math.max(0, (clientX - rect.left) * scaleX)),
      y: Math.min(canvas.height, Math.max(0, (clientY - rect.top)  * scaleY)),
    };
  }

  private drawCropOverlay() {
    const canvas = this.cropCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { x1, y1, x2, y2 } = this.cropRect;
    const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (rw < 2 || rh < 2) return;

    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.clearRect(rx, ry, rw, rh);

    ctx.strokeStyle = '#48c78e';
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.setLineDash([]);
    ctx.fillStyle = '#48c78e';
    const hs = 6;
    [[rx, ry], [rx+rw, ry], [rx, ry+rh], [rx+rw, ry+rh]].forEach(([cx, cy]) => {
      ctx.fillRect(cx - hs/2, cy - hs/2, hs, hs);
    });
  }

  async confirmCrop() {
    const img    = this.cropImgRef.nativeElement;
    const canvas = this.cropCanvasRef.nativeElement;
    const scaleX = img.naturalWidth  / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;
    const { x1, y1, x2, y2 } = this.cropRect;
    const rx = Math.min(x1, x2) * scaleX;
    const ry = Math.min(y1, y2) * scaleY;
    const rw = Math.abs(x2 - x1) * scaleX;
    const rh = Math.abs(y2 - y1) * scaleY;

    const out  = document.createElement('canvas');
    out.width  = rw;
    out.height = rh;
    out.getContext('2d')!.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);
    await this.runScan(out.toDataURL('image/png'));
  }

  async skipCrop() {
    await this.runScan(this.imagePreview()!);
  }

  // ── Core scan ─────────────────────────────────────────────────────
  private async runScan(dataUrl: string) {
    this.status.set('scanning');
    this.progress.set(0);
    try {
      // Try multiple preprocessing strategies and merge candidates
      const strategies = [
        this.preprocessImage(dataUrl, 'binarize'),
        this.preprocessImage(dataUrl, 'contrast'),
        this.preprocessImage(dataUrl, 'invert'),
      ];
      const canvases = await Promise.all(strategies);

      if (!this.workerReady || !this.worker) await this.initWorker();

      const allText: string[] = [];
      for (const canvas of canvases) {
        const result = await this.worker!.recognize(canvas);
        allText.push(result.data.text);
      }

      this.extractAndConfirm(allText.join('\n'));
    } catch {
      this.status.set('error');
      this.errorMsg.set('Error al procesar la imagen. Intente de nuevo.');
    }
  }

  /** Extract candidates and go to confirmation step */
  private extractAndConfirm(text: string) {
    const normalized = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').toUpperCase().trim();
    this.rawOcrText.set(normalized);

    const patterns = [
      /(\d{7,10})\s+([A-Z])\b/g,
      /(\d{7,10})([A-Z])\b/g,
      /(\d{7,10})\s*([A-Z])/g,
      /(\d{6,10})\s+([A-Z])/g,
    ];
    const candidates: Array<{ num: number; letter: string }> = [];
    const seen = new Set<string>();
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(normalized)) !== null) {
        const key = `${match[1]}-${match[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ num: parseInt(match[1], 10), letter: match[2] });
        }
      }
    }

    // Sort: prefer B series, then longest number
    const sorted = [...candidates].sort((a, b) => {
      if (a.letter === 'B' && b.letter !== 'B') return -1;
      if (a.letter !== 'B' && b.letter === 'B') return 1;
      return String(b.num).length - String(a.num).length;
    });

    this.allCandidates.set(sorted);

    if (sorted.length > 0) {
      this.editSerialNum.set(String(sorted[0].num));
      this.editSerialLetter.set(sorted[0].letter);
    } else {
      this.editSerialNum.set('');
      this.editSerialLetter.set('');
    }

    this.status.set('confirming');
  }

  /** Called when user confirms the serial (edited or not) */
  confirmSerial() {
    const numStr = this.editSerialNum().replace(/\s/g, '');
    const letter = this.editSerialLetter().toUpperCase().trim();
    const num = parseInt(numStr, 10);

    if (!num || isNaN(num) || !letter) {
      this.status.set('done');
      this.isValid.set(null);
      this.errorMsg.set('Número inválido. Intente de nuevo.');
      return;
    }

    this.detectedSerial.set(`${num} ${letter}`);

    if (letter !== 'B') {
      this.errorMsg.set(`Serie ${letter} — no pertenece a los billetes ilegales`);
      this.status.set('done');
      this.isValid.set(true);
      return;
    }

    const illegalDenom = this.checkInRanges(num);
    if (illegalDenom) {
      this.detectedDenom.set(illegalDenom);
      this.errorMsg.set(`Registrado como billete Serie B ilegalizado (${illegalDenom})`);
      this.status.set('done');
      this.isValid.set(false);
    } else {
      this.detectedDenom.set(null);
      this.errorMsg.set('Serie B — número no figura en registros ilegalizados');
      this.status.set('done');
      this.isValid.set(true);
    }
  }

  /** Select a different candidate from the list */
  selectCandidate(c: { num: number; letter: string }) {
    this.editSerialNum.set(String(c.num));
    this.editSerialLetter.set(c.letter);
  }

  /** Go back to confirming step from result to edit and re-verify */
  editFromResult() {
    const serial = this.detectedSerial();
    if (serial) {
      const parts = serial.split(' ');
      this.editSerialNum.set(parts[0] ?? '');
      this.editSerialLetter.set(parts[1] ?? '');
    }
    this.isValid.set(null);
    this.detectedSerial.set(null);
    this.detectedDenom.set(null);
    this.errorMsg.set(null);
    this.status.set('confirming');
  }

  private checkInRanges(num: number): string | null {
    if (!this.seriesData) return null;
    for (const [denom, ranges] of Object.entries(this.seriesData))
      for (const r of ranges)
        if (num >= r.del && num <= r.al) return denom.replace('Bs', 'Bs. ');
    return null;
  }

  private preprocessImage(dataUrl: string, strategy: 'binarize' | 'contrast' | 'invert'): Promise<HTMLCanvasElement> {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const tmp = document.createElement('canvas');
        tmp.width = img.width; tmp.height = img.height;
        const tctx = tmp.getContext('2d')!;
        tctx.drawImage(img, 0, 0);
        const { x, y, w, h } = this.autoCrop(tctx, img.width, img.height);

        // Scale up aggressively — small text needs at least 3x
        const scale = Math.max(2, Math.min(5, 3000 / Math.max(w, h)));
        const canvas = document.createElement('canvas');
        canvas.width = w * scale; canvas.height = h * scale;
        const ctx = canvas.getContext('2d')!;

        // Draw with initial greyscale
        ctx.filter = 'grayscale(100%)';
        ctx.drawImage(tmp, x, y, w, h, 0, 0, canvas.width, canvas.height);

        const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = id.data;

        if (strategy === 'binarize') {
          // Adaptive Otsu-like binarization
          const histogram = new Array(256).fill(0);
          for (let i = 0; i < d.length; i += 4) histogram[d[i]]++;
          const totalPixels = d.length / 4;
          let sum = 0;
          for (let i = 0; i < 256; i++) sum += i * histogram[i];
          let sumB = 0, wB = 0, wF = 0, maxVariance = 0, threshold = 128;
          for (let t = 0; t < 256; t++) {
            wB += histogram[t];
            if (wB === 0) continue;
            wF = totalPixels - wB;
            if (wF === 0) break;
            sumB += t * histogram[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const variance = wB * wF * (mB - mF) * (mB - mF);
            if (variance > maxVariance) { maxVariance = variance; threshold = t; }
          }
          for (let i = 0; i < d.length; i += 4) {
            const v = d[i] > threshold ? 255 : 0;
            d[i] = d[i+1] = d[i+2] = v;
          }
        } else if (strategy === 'contrast') {
          // High contrast + sharpen
          for (let i = 0; i < d.length; i += 4) {
            const c = Math.min(255, Math.max(0, (d[i] - 128) * 2.5 + 128));
            d[i] = d[i+1] = d[i+2] = c;
          }
        } else if (strategy === 'invert') {
          // Otsu binarize but inverted (for dark backgrounds)
          const histogram = new Array(256).fill(0);
          for (let i = 0; i < d.length; i += 4) histogram[d[i]]++;
          const totalPixels = d.length / 4;
          let sum = 0;
          for (let i = 0; i < 256; i++) sum += i * histogram[i];
          let sumB = 0, wB = 0, wF = 0, maxVariance = 0, threshold = 128;
          for (let t = 0; t < 256; t++) {
            wB += histogram[t];
            if (wB === 0) continue;
            wF = totalPixels - wB;
            if (wF === 0) break;
            sumB += t * histogram[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const variance = wB * wF * (mB - mF) * (mB - mF);
            if (variance > maxVariance) { maxVariance = variance; threshold = t; }
          }
          for (let i = 0; i < d.length; i += 4) {
            const v = d[i] > threshold ? 0 : 255;
            d[i] = d[i+1] = d[i+2] = v;
          }
        }

        ctx.putImageData(id, 0, 0);
        resolve(canvas);
      };
      img.src = dataUrl;
    });
  }

  private autoCrop(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const id = ctx.getImageData(0, 0, w, h); const d = id.data;
    const isB = (px: number) => d[px] > 240 && d[px+1] > 240 && d[px+2] > 240;
    let top = 0, bottom = h-1, left = 0, right = w-1;
    outer: for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { if (!isB((r*w+c)*4)) { top = r; break outer; } }
    outer: for (let r = h-1; r >= 0; r--) for (let c = 0; c < w; c++) { if (!isB((r*w+c)*4)) { bottom = r; break outer; } }
    outer: for (let c = 0; c < w; c++) for (let r = 0; r < h; r++) { if (!isB((r*w+c)*4)) { left = c; break outer; } }
    outer: for (let c = w-1; c >= 0; c--) for (let r = 0; r < h; r++) { if (!isB((r*w+c)*4)) { right = c; break outer; } }
    const p = 8;
    return { x: Math.max(0,left-p), y: Math.max(0,top-p), w: Math.min(w,right-left+p*2), h: Math.min(h,bottom-top+p*2) };
  }

  private readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target!.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  private resetState() {
    this.isValid.set(null);
    this.detectedSerial.set(null);
    this.detectedDenom.set(null);
    this.errorMsg.set(null);
    this.progress.set(0);
    this.hasCropSelection.set(false);
    this.cropDragging = false;
    this.cropRect = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this.editSerialNum.set('');
    this.editSerialLetter.set('');
    this.rawOcrText.set('');
    this.allCandidates.set([]);
  }

  reset() {
    this.resetState();
    this.status.set('idle');
    this.imagePreview.set(null);
    if (this.fileInput) this.fileInput.nativeElement.value = '';
    if (this.galleryInput) this.galleryInput.nativeElement.value = '';
  }

  ngOnDestroy() { this.worker?.terminate(); }
}
