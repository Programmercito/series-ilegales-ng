import { Component, signal, ViewChild, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { createWorker, Worker } from 'tesseract.js';

interface SeriesRange { del: number; al: number; }
interface SeriesData { [key: string]: SeriesRange[]; }

type ScanStatus = 'idle' | 'loading' | 'scanning' | 'done' | 'error';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  status = signal<ScanStatus>('idle');
  progress = signal<number>(0);
  progressMsg = signal<string>('Iniciando...');
  imagePreview = signal<string | null>(null);
  isValid = signal<boolean | null>(null);
  detectedSerial = signal<string | null>(null);
  detectedDenom = signal<string | null>(null);
  errorMsg = signal<string | null>(null);
  rawText = signal<string | null>(null);

  private seriesData: SeriesData | null = null;
  private worker: Worker | null = null;
  private workerReady = false;

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
        if (m.status === 'recognizing text') {
          this.progress.set(Math.round(m.progress * 100));
        }
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
    });
    this.workerReady = true;
  }

  triggerFileInput() {
    this.fileInput.nativeElement.click();
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    await this.processImage(input.files[0]);
  }

  async processImage(file: File) {
    this.status.set('loading');
    this.isValid.set(null);
    this.detectedSerial.set(null);
    this.detectedDenom.set(null);
    this.errorMsg.set(null);
    this.rawText.set(null);
    this.progress.set(0);

    const preview = await this.readFileAsDataURL(file);
    this.imagePreview.set(preview);

    const preprocessed = await this.preprocessImage(preview);

    this.status.set('scanning');
    try {
      if (!this.workerReady || !this.worker) await this.initWorker();
      const result = await this.worker!.recognize(preprocessed);
      this.rawText.set(result.data.text);
      this.analyzeText(result.data.text);
    } catch {
      this.status.set('error');
      this.errorMsg.set('Error al procesar la imagen. Intente de nuevo.');
    }
  }

  private analyzeText(text: string) {
    const normalized = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').toUpperCase().trim();

    // Patterns: 7-10 digits followed by a single letter
    const patterns = [
      /\b(\d{7,10})\s+([A-Z])\b/g,
      /\b(\d{7,10})([A-Z])\b/g,
      /(\d{7,10})\s*([A-Z])/g,
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
      if (candidates.length > 0) break;
    }

    if (candidates.length === 0) {
      this.status.set('done');
      this.isValid.set(null);
      this.errorMsg.set('No se detectó número de serie. Intente con mejor iluminación o enfoque.');
      return;
    }

    // Prefer Serie B candidates
    const sorted = [...candidates].sort((a, b) =>
      (a.letter === 'B' ? -1 : 1) - (b.letter === 'B' ? -1 : 1)
    );
    const best = sorted[0];
    this.detectedSerial.set(`${best.num} ${best.letter}`);

    // LOGIC:
    // - Non-B series               → VALID (no son billetes quemados)
    // - Serie B en rangos ilegales → INVALID (billete quemado robado)
    // - Serie B fuera de rangos    → VALID
    if (best.letter !== 'B') {
      this.detectedDenom.set(null);
      this.errorMsg.set(`Serie ${best.letter} — no pertenece a los billetes ilegales`);
      this.status.set('done');
      this.isValid.set(true);
      return;
    }

    const illegalDenom = this.checkInRanges(best.num);
    if (illegalDenom) {
      // Serie B dentro del rango ilegal → INVÁLIDO
      this.detectedDenom.set(illegalDenom);
      this.errorMsg.set(`Registrado como billete Serie B ilegalizado (${illegalDenom})`);
      this.status.set('done');
      this.isValid.set(false);
    } else {
      // Serie B fuera del rango ilegal → VÁLIDO
      this.detectedDenom.set(null);
      this.errorMsg.set('Serie B — número no figura en registros ilegalizados');
      this.status.set('done');
      this.isValid.set(true);
    }
  }

  private checkInRanges(num: number): string | null {
    if (!this.seriesData) return null;
    for (const [denom, ranges] of Object.entries(this.seriesData)) {
      for (const r of ranges) {
        if (num >= r.del && num <= r.al) {
          return denom.replace('Bs', 'Bs. ');
        }
      }
    }
    return null;
  }

  /** Auto-crop: trim near-white/near-black uniform borders and scale up */
  private preprocessImage(dataUrl: string): Promise<HTMLCanvasElement> {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        // Step 1: draw original to temp canvas
        const tmp = document.createElement('canvas');
        tmp.width = img.width;
        tmp.height = img.height;
        const tctx = tmp.getContext('2d')!;
        tctx.drawImage(img, 0, 0);

        // Step 2: auto-crop uniform border
        const { x, y, w, h } = this.autoCrop(tctx, img.width, img.height);

        // Step 3: scale cropped region
        const scale = Math.max(1, Math.min(4, 2000 / Math.max(w, h)));
        const canvas = document.createElement('canvas');
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext('2d')!;
        ctx.filter = 'grayscale(100%) contrast(170%) brightness(115%)';
        ctx.drawImage(tmp, x, y, w, h, 0, 0, canvas.width, canvas.height);

        // Step 4: extra local contrast pass
        const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
          const v = d[i];
          const c = (v - 128) * 1.5 + 128;
          const cl = Math.min(255, Math.max(0, c));
          d[i] = d[i + 1] = d[i + 2] = cl;
        }
        ctx.putImageData(id, 0, 0);
        resolve(canvas);
      };
      img.src = dataUrl;
    });
  }

  private autoCrop(ctx: CanvasRenderingContext2D, w: number, h: number)
    : { x: number; y: number; w: number; h: number } {
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const THRESH = 240; // treat pixels brighter than this as border
    const isBorder = (px: number) => d[px] > THRESH && d[px+1] > THRESH && d[px+2] > THRESH;

    let top = 0, bottom = h - 1, left = 0, right = w - 1;

    outer: for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        if (!isBorder((row * w + col) * 4)) { top = row; break outer; }
      }
    }
    outer: for (let row = h - 1; row >= 0; row--) {
      for (let col = 0; col < w; col++) {
        if (!isBorder((row * w + col) * 4)) { bottom = row; break outer; }
      }
    }
    outer: for (let col = 0; col < w; col++) {
      for (let row = 0; row < h; row++) {
        if (!isBorder((row * w + col) * 4)) { left = col; break outer; }
      }
    }
    outer: for (let col = w - 1; col >= 0; col--) {
      for (let row = 0; row < h; row++) {
        if (!isBorder((row * w + col) * 4)) { right = col; break outer; }
      }
    }

    // Add small padding
    const pad = 8;
    return {
      x: Math.max(0, left - pad),
      y: Math.max(0, top - pad),
      w: Math.min(w, right - left + pad * 2),
      h: Math.min(h, bottom - top + pad * 2),
    };
  }

  private readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target!.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) this.processImage(file);
  }

  reset() {
    this.status.set('idle');
    this.imagePreview.set(null);
    this.isValid.set(null);
    this.detectedSerial.set(null);
    this.detectedDenom.set(null);
    this.errorMsg.set(null);
    this.rawText.set(null);
    this.progress.set(0);
    if (this.fileInput) this.fileInput.nativeElement.value = '';
  }

  ngOnDestroy() {
    this.worker?.terminate();
  }
}
