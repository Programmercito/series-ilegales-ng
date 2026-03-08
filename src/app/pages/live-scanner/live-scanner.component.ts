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
            // SPARSE_TEXT is more tolerant with text mixed in patterned backgrounds
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

    private async processFrame() {
        const video = this.videoElement?.nativeElement;
        const canvas = this.canvasElement?.nativeElement;
        if (!video || !canvas || video.videoWidth === 0) return;

        const vw = video.videoWidth;
        const vh = video.videoHeight;

        // ── Step 1: Crop the central horizontal strip (25%–75% of height)
        // Bill serial numbers are usually on the horizontal center of the note.
        const cropY = Math.floor(vh * 0.25);
        const cropH = Math.floor(vh * 0.5);

        // ── Step 2: Scale up for better OCR accuracy (min 800px wide)
        const targetW = Math.max(800, Math.min(1200, vw));
        const scale = targetW / vw;
        const targetH = Math.round(cropH * scale);

        canvas.width = targetW;
        canvas.height = targetH;

        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

        // ── Step 3: Draw the cropped region scaled up, with basic contrast boost
        ctx.filter = 'grayscale(100%) contrast(200%) brightness(110%)';
        ctx.drawImage(video, 0, cropY, vw, cropH, 0, 0, targetW, targetH);
        ctx.filter = 'none';

        // ── Step 4: Adaptive threshold to remove banknote background texture
        this.applyAdaptiveThreshold(ctx, targetW, targetH);

        const dataUrl = canvas.toDataURL('image/png');

        if (!this.worker) return;
        const result = await this.worker.recognize(dataUrl);
        this.extractAndVerify(result.data.text);
    }

    /**
     * Adaptive threshold: for each pixel, compare its brightness to the
     * local neighborhood average. If brighter → white, else → black.
     * This removes textured banknote backgrounds while preserving printed digits.
     */
    private applyAdaptiveThreshold(ctx: CanvasRenderingContext2D, w: number, h: number) {
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const blockSize = 21; // neighborhood radius
        const C = 10;         // constant subtracted from mean

        // Convert to grayscale in-place
        const gray = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }

        // Compute integral image for fast local mean
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
                const pixel = gray[y * w + x] < mean - C ? 0 : 255;
                const idx = (y * w + x) * 4;
                data[idx] = data[idx + 1] = data[idx + 2] = pixel;
                data[idx + 3] = 255;
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    private extractAndVerify(text: string) {
        // Fix common OCR confusions for digits on banknote patterns:
        //   O → 0,  I → 1,  S → 5 (only in digit positions)
        const normalized = text
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .toUpperCase()
            .trim();

        // Replace common OCR digit mistakes inside numeric sequences
        const digitFix = normalized.replace(/(\d|[OoIiSs]){7,}/g, (seq) =>
            seq.replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5')
        );

        const patterns = [
            /(\d{7,10})\s+([A-Z])\b/g,
            /(\d{7,10})([A-Z])\b/g,
        ];

        const candidates: Array<{ num: number; letter: string }> = [];
        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            pattern.lastIndex = 0;
            while ((match = pattern.exec(digitFix)) !== null) {
                candidates.push({ num: parseInt(match[1], 10), letter: match[2] });
            }
        }

        if (candidates.length === 0) return;

        // Pick top candidate (prefer B)
        const sorted = candidates.sort((a, b) => {
            if (a.letter === 'B' && b.letter !== 'B') return -1;
            if (a.letter !== 'B' && b.letter === 'B') return 1;
            return String(b.num).length - String(a.num).length;
        });

        const topCandidate = sorted[0];
        const serialStr = `${topCandidate.num} ${topCandidate.letter}`;

        // Avoid multiple detections of the same serial within a session
        if (this.recentSerials.has(serialStr)) return;

        // Found a new serial!
        this.recentSerials.add(serialStr);
        this.playBeep(); // Audio feedback

        // Verify it
        const denom = this.selectedDenom()!;
        this.validationService.validateSerial(topCandidate.num, topCandidate.letter, denom).then(res => {
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
