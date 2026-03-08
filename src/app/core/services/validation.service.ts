import { Injectable } from '@angular/core';

export interface FormatEntry { s: number; e: number; denom: number; p: number; }

export interface EspecialEntry {
  key: string;
  denom: number;
  min: number;
  max: number;
  json: string;
}

export interface EspecialHit {
  entry: EspecialEntry;
  subRange: [number, number];
}

export interface ValidationResult {
  isValid: boolean;
  message: string;
  matchedRange?: FormatEntry | null;
  especialHit?: EspecialHit | null;
  especialForDenom?: EspecialEntry | null;
  denomRanges?: FormatEntry[];
}

@Injectable({
  providedIn: 'root'
})
export class ValidationService {
  private seriesData: FormatEntry[] | null = null;
  private especialData: EspecialEntry[] | null = null;
  private subJsonCache: Record<string, [number, number][]> = {};

  constructor() {}

  async loadData() {
    if (!this.seriesData) {
      const res = await fetch('/formatbcbv2.json');
      this.seriesData = await res.json();
    }
    if (!this.especialData) {
      const res = await fetch('/especialv2.json');
      this.especialData = await res.json();
    }
  }

  getDenomRanges(denom: number): FormatEntry[] {
    if (!this.seriesData) return [];
    return this.seriesData.filter(e => e.denom === denom);
  }

  getEspecialForDenom(denom: number, num: number): EspecialEntry | null {
    if (!this.especialData) return null;
    return this.especialData.find(e => e.denom === denom && num >= e.min && num <= e.max) ?? null;
  }

  async validateSerial(num: number, letter: string, denom: number): Promise<ValidationResult> {
    await this.loadData();
    
    const denomRanges = this.getDenomRanges(denom);
    const especialForDenom = this.getEspecialForDenom(denom, num);

    if (letter !== 'B') {
      return {
        isValid: true,
        message: `Serie ${letter} — no pertenece a los billetes ilegales`,
        denomRanges,
        especialForDenom
      };
    }

    // 1) Buscar en formatbcbv2.json
    const rangeHit = this.checkInRanges(num, denom);
    if (rangeHit) {
      return {
        isValid: false,
        message: `Registrado como billete Serie B ilegalizado (Bs. ${rangeHit.denom})`,
        matchedRange: rangeHit,
        denomRanges,
        especialForDenom
      };
    }

    // 2) No encontrado en formatbcbv2 → buscar en especialv2.json
    if (this.especialData) {
      const especialEntry = this.especialData.find(e => e.denom === denom && num >= e.min && num <= e.max);
      if (especialEntry) {
        const hit = await this.checkInSubJson(num, especialEntry);
        if (hit) {
          return {
            isValid: false,
            message: `Registrado en sub-serie "${especialEntry.key}" — billete ilegalizado`,
            especialHit: hit,
            denomRanges,
            especialForDenom
          };
        }
      }
    }

    // 3) VÁLIDO
    return {
      isValid: true,
      message: 'Serie B — número no figura en registros ilegalizados',
      denomRanges,
      especialForDenom
    };
  }

  private checkInRanges(num: number, denom: number): FormatEntry | null {
    if (!this.seriesData) return null;
    for (const entry of this.seriesData) {
      if (entry.denom === denom && num >= entry.s && num <= entry.e) {
        return entry;
      }
    }
    return null;
  }

  private async checkInSubJson(num: number, entry: EspecialEntry): Promise<EspecialHit | null> {
    try {
      if (!this.subJsonCache[entry.json]) {
        const res = await fetch(`/${entry.json}.json`);
        this.subJsonCache[entry.json] = await res.json();
      }
      const data = this.subJsonCache[entry.json];
      for (const [min, max] of data) {
        if (num >= min && num <= max) {
          return { entry, subRange: [min, max] };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
