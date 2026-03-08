import { Component, signal, ViewChild, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { createWorker, Worker, PSM } from 'tesseract.js';
import { ValidationService, ValidationResult } from '../../core/services/validation.service';

type CameraStatus = 'select-denom' | 'starting' | 'scanning' | 'error';

interface ScannedBill {
    id: number;
    serial: string;
    denom: number;
    result: ValidationResult;
    timestamp: Date;
}

@Component({
    selector: 'app-live-scanner',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './live-scanner.component.html',
    styleUrl: './live-scanner.component.scss'
})
export class LiveScannerComponent implements OnInit, OnDestroy {
    @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
    @ViewChild('canvasElement') canvasElement!: ElementRef<HTMLCanvasElement>;

    status = signal<CameraStatus>('select-denom');
    selectedDenom = signal<number | null>(null);
    errorMsg = signal<string | null>(null);
    progressMsg = signal<string>('Iniciando...');

    scannedBills = signal<ScannedBill[]>([]);
    recentSerials = new Set<string>(); // To avoid duplicate scans in a short period

    private worker: Worker | null = null;
    private workerReady = false;
    private stream: MediaStream | null = null;
    private cameraTimeout: ReturnType<typeof setTimeout> | null = null;
    private scanInterval: ReturnType<typeof setInterval> | null = null;
    private isProcessingFrame = false;
    private billIdCounter = 0;
    // Rotate through preprocessing variants each scan cycle
    private variantIndex = 0;

    constructor(private validationService: ValidationService) { }

    async ngOnInit() {
        await this.validationService.loadData();
        await this.initWorker();
    }

    ngOnDestroy() {
        this.stopCamera();
        this.worker?.terminate();
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
    }

    async selectDenom(denom: number) {
        this.selectedDenom.set(denom);
        await this.startCamera();
    }

    private async initWorker() {
        this.worker = await createWorker('eng', 1, {
            logger: (m: any) => {
                const msgs: Record<string, string> = {
                    'loading tesseract core': 'Cargando motor OCR...',
                    'initializing tesseract': 'Inicializando...',
                    'loading language traineddata': 'Cargando idioma...',
                    'initialized tesseract': 'Motor listo',
                    'recognizing text': 'Analizando...',
                };
                this.progressMsg.set(msgs[m.status] ?? 'Preparando...');
            }
        });
        await this.worker.setParameters({
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
            // SPARSE_TEXT: tolerant with patterned/textured backgrounds like banknotes
            tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        });
        this.workerReady = true;
    }

    private async startCamera() {
        this.status.set('starting');
        this.errorMsg.set(null);
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' } // Prefer back camera
            });
            // Give angular a bit more time to render the *ngIf / @if for 'scanning' state
            this.status.set('scanning');
            if (this.cameraTimeout) clearTimeout(this.cameraTimeout);
            this.cameraTimeout = setTimeout(() => {
                if (this.videoElement?.nativeElement) {
                    this.videoElement.nativeElement.srcObject = this.stream;
                    this.videoElement.nativeElement.play().catch(e => console.error("Play auto error:", e));
                    this.startScanningLoop();
                } else {
                    this.status.set('error');
                    this.errorMsg.set('No se pudo inicializar la vista de la cámara.');
                }
            }, 500);
        } catch (err: any) {
            this.status.set('error');
            this.errorMsg.set('No se pudo acceder a la cámara. Asegúrese de otorgar los permisos y que su dispositivo tenga cámara.');
        }
    }

    private stopCamera() {
        if (this.cameraTimeout) {
            clearTimeout(this.cameraTimeout);
            this.cameraTimeout = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
    }

    private startScanningLoop() {
        // Attempt to scan frame every 1500ms — allows frame to stabilize
        this.scanInterval = setInterval(async () => {
            if (this.isProcessingFrame || !this.workerReady || this.status() !== 'scanning') return;

            this.isProcessingFrame = true;
            try {
                await this.processFrame();
            } catch (err) {
                console.error('Frame processing error', err);
            } finally {
                this.isProcessingFrame = false;
            }
        }, 1500);
    }

    /**
     * Preprocessing variants — rotated each scan tick so we try
     * different strategies without slowing down a single frame.
     *
     * v0 – center strip, adaptive threshold (dark text on light bg)
     * v1 – center strip, adaptive threshold INVERTED (light text on dark bg)
     * v2 – center strip, high contrast grayscale only (no binary threshold)
     * v3 – wider strip, unsharp mask + adaptive threshold
     */
    private readonly VARIANTS = [
        { cropTop: 0.25, cropBot: 0.75, invert: false, sharpen: false, threshold: true },
        { cropTop: 0.25, cropBot: 0.75, invert: true, sharpen: false, threshold: true },
        { cropTop: 0.20, cropBot: 0.80, invert: false, sharpen: false, threshold: false },
        { cropTop: 0.20, cropBot: 0.80, invert: false, sharpen: true, threshold: true },
    ] as const;

    private async processFrame() {
        const video = this.videoElement?.nativeElement;
        const canvas = this.canvasElement?.nativeElement;
        if (!video || !canvas || video.videoWidth === 0) return;

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!this.worker) return;

        // Pick current variant and advance index
        const variant = this.VARIANTS[this.variantIndex % this.VARIANTS.length];
        this.variantIndex++;

        // ── Crop region
        const cropY = Math.floor(vh * variant.cropTop);
        const cropH = Math.floor(vh * (variant.cropBot - variant.cropTop));

        // ── Scale to at least 900px wide for fine-detail OCR
        const targetW = Math.max(900, Math.min(1400, vw));
        const scale = targetW / vw;
        const targetH = Math.round(cropH * scale);

        canvas.width = targetW;
        canvas.height = targetH;

        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

        // ── Draw with grayscale + contrast boost
        ctx.filter = 'grayscale(100%) contrast(210%) brightness(105%)';
        ctx.drawImage(video, 0, cropY, vw, cropH, 0, 0, targetW, targetH);
        ctx.filter = 'none';

        // ── Optional sharpening (unsharp mask via convolution)
        if (variant.sharpen) {
            this.applySharpen(ctx, targetW, targetH);
        }

        // ── Optional adaptive threshold
        if (variant.threshold) {
            this.applyAdaptiveThreshold(ctx, targetW, targetH, variant.invert);
        }

        const dataUrl = canvas.toDataURL('image/png');

        const result = await this.worker.recognize(dataUrl);
        this.extractAndVerify(result.data.text);
    }

    /** Simple 3×3 unsharp mask to make thin digit strokes crisper. */
    private applySharpen(ctx: CanvasRenderingContext2D, w: number, h: number) {
        const src = ctx.getImageData(0, 0, w, h);
        const dst = ctx.createImageData(w, h);
        const s: Uint8ClampedArray = src.data;
        const d: Uint8ClampedArray = dst.data;
        // kernel: center=5, edges=-1, corners=0  (equivalent to sharpen)
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                for (let c = 0; c < 3; c++) {
                    const i = (y * w + x) * 4 + c;
                    const val =
                        5 * s[i]
                        - s[((y - 1) * w + x) * 4 + c]
                        - s[((y + 1) * w + x) * 4 + c]
                        - s[(y * w + x - 1) * 4 + c]
                        - s[(y * w + x + 1) * 4 + c];
                    d[i] = Math.min(255, Math.max(0, val));
                }
                d[(y * w + x) * 4 + 3] = 255;
            }
        }
        ctx.putImageData(dst, 0, 0);
    }

    /**
     * Adaptive threshold using an integral-image box filter for speed.
     * invert=true flips the binary result — useful for light-on-dark serials.
     */
    private applyAdaptiveThreshold(
        ctx: CanvasRenderingContext2D, w: number, h: number, invert = false
    ) {
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const blockSize = 25; // larger block → better for noisy banknote backgrounds
        const C = 8;

        // Luminance to grayscale
        const gray = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            gray[i] = Math.round(
                0.299 * data[i * 4] +
                0.587 * data[i * 4 + 1] +
                0.114 * data[i * 4 + 2]
            );
        }

        // Integral image
        const integral = new Float64Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                integral[(y + 1) * (w + 1) + (x + 1)] =
                    gray[y * w + x]
                    + integral[y * (w + 1) + (x + 1)]
                    + integral[(y + 1) * (w + 1) + x]
                    - integral[y * (w + 1) + x];
            }
        }

        const half = Math.floor(blockSize / 2);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const x1 = Math.max(0, x - half);
                const y1 = Math.max(0, y - half);
                const x2 = Math.min(w - 1, x + half);
                const y2 = Math.min(h - 1, y + half);
                const count = (x2 - x1 + 1) * (y2 - y1 + 1);
                const sum =
                    integral[(y2 + 1) * (w + 1) + (x2 + 1)]
                    - integral[y1 * (w + 1) + (x2 + 1)]
                    - integral[(y2 + 1) * (w + 1) + x1]
                    + integral[y1 * (w + 1) + x1];
                const mean = sum / count;
                let isDark = gray[y * w + x] < mean - C;
                if (invert) isDark = !isDark;
                const pixel = isDark ? 0 : 255;
                const idx = (y * w + x) * 4;
                data[idx] = data[idx + 1] = data[idx + 2] = pixel;
                data[idx + 3] = 255;
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    private extractAndVerify(text: string) {
        // ── Normalize raw OCR text ──────────────────────────────────────
        const normalized = text
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .toUpperCase()
            .trim();

        // ── Fix O→0 and S→5 ONLY within pure digit runs ────────────────
        // We do NOT touch I/J/L here because they may be the series letter
        // right after the number (e.g. "118034088 J")
        const fixedText = normalized.replace(/\b[0-9OS]{6,}\b/g, (seq) =>
            seq.replace(/O/g, '0').replace(/S/g, '5')
        );

        // ── Match: 7-10 digits, optional space, then a capital letter ──
        const patterns = [
            /(\d{7,10})\s+([A-Z])\b/g,   // "118034088 J"
            /(\d{7,10})([A-Z])\b/g,       // "118034088J"
        ];

        const candidates: Array<{ num: number; letter: string; len: number }> = [];
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(fixedText)) !== null) {
                candidates.push({
                    num: parseInt(match[1], 10),
                    letter: match[2],
                    len: match[1].length,
                });
            }
        }

        if (candidates.length === 0) return;

        // ── Pick best candidate: prefer longer digit sequence ───────────
        const best = candidates.reduce((a, b) => a.len >= b.len ? a : b);
        const serialStr = `${best.num} ${best.letter}`;

        // Avoid multiple detections of the same serial within a session
        if (this.recentSerials.has(serialStr)) return;

        // Found a new serial!
        this.recentSerials.add(serialStr);
        this.playBeep(); // Audio feedback

        // Verify it
        const denom = this.selectedDenom()!;
        this.validationService.validateSerial(best.num, best.letter, denom).then(res => {
            const newBill: ScannedBill = {
                id: ++this.billIdCounter,
                serial: serialStr,
                denom: denom,
                result: res,
                timestamp: new Date()
            };

            // Prepend to list
            this.scannedBills.update(bills => [newBill, ...bills]);
        });
    }

    private playBeep() {
        try {
            if ('vibrate' in navigator) navigator.vibrate(200);
            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz (A5)
            gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                audioCtx.close();
            }, 150);
        } catch (e) {
            // AudioContext / vibrate might fail if user hasn't interacted, ignore
        }
    }

    reset() {
        this.stopCamera();
        this.selectedDenom.set(null);
        this.scannedBills.set([]);
        this.recentSerials.clear();
        this.status.set('select-denom');
    }
}
