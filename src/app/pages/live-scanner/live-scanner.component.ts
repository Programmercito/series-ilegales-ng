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
            tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
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
        // Attempt to scan frame every 1000ms
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
        }, 1000);
    }

    private async processFrame() {
        const video = this.videoElement?.nativeElement;
        const canvas = this.canvasElement?.nativeElement;
        if (!video || !canvas || video.videoWidth === 0) return;

        // To improve OCR performance on a full video frame, we resize and crop the central area or process the whole frame.
        // We will extract a middle/central slice which usually corresponds to where the user will point the bill.
        const vw = video.videoWidth;
        const vh = video.videoHeight;

        // Set canvas to a fixed size for tesseract efficiency
        const targetW = Math.min(600, vw);
        const scale = targetW / vw;
        const targetH = vh * scale;

        canvas.width = targetW;
        canvas.height = targetH;

        const ctx = canvas.getContext('2d')!;

        // Grayscale / High Contrast filter
        ctx.filter = 'grayscale(100%) contrast(170%) brightness(115%)';
        ctx.drawImage(video, 0, 0, targetW, targetH);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        if (!this.worker) return;
        const result = await this.worker.recognize(dataUrl);
        this.extractAndVerify(result.data.text);
    }

    private extractAndVerify(text: string) {
        const normalized = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').toUpperCase().trim();

        const patterns = [
            /(\d{7,10})\s+([A-Z])\b/g,
            /(\d{7,10})([A-Z])\b/g,
        ];

        const candidates: Array<{ num: number; letter: string }> = [];
        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            pattern.lastIndex = 0;
            while ((match = pattern.exec(normalized)) !== null) {
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
