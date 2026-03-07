import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

interface FormatEntry { s: number; e: number; denom: number; p: number; }

interface EspecialEntry {
  key: string;
  denom: number;
  min: number;
  max: number;
  json: string;
}

interface EspecialCardState {
  entry: EspecialEntry;
  open: boolean;
  loading: boolean;
  subRanges: [number, number][];
  page: number;
  pageSize: number;
  error: string | null;
}

interface DenomGroup {
  label: string;
  key: string;
  ranges: FormatEntry[];
  total: number;
  especiales: EspecialCardState[];
}

@Component({
  selector: 'app-seriales',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './seriales.component.html',
  styleUrl: './seriales.component.scss'
})
export class SerialesComponent implements OnInit {
  groups = signal<DenomGroup[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  async ngOnInit() {
    try {
      const [resMain, resEspecial] = await Promise.all([
        fetch('/formatbcbv2.json'),
        fetch('/especialv2.json')
      ]);
      const data: FormatEntry[] = await resMain.json();
      const especialData: EspecialEntry[] = await resEspecial.json();

      const denomOrder = [10, 20, 50];
      const grouped = new Map<number, FormatEntry[]>();
      for (const entry of data) {
        if (!grouped.has(entry.denom)) grouped.set(entry.denom, []);
        grouped.get(entry.denom)!.push(entry);
      }

      const built: DenomGroup[] = [];
      for (const denom of denomOrder) {
        const ranges = grouped.get(denom);
        if (!ranges) continue;
        const total = ranges.reduce((acc, r) => acc + (r.e - r.s + 1), 0);
        const especiales: EspecialCardState[] = especialData
          .filter(e => e.denom === denom)
          .map(e => ({ entry: e, open: false, loading: false, subRanges: [], page: 0, pageSize: 50, error: null }));
        built.push({ label: `Bs. ${denom}`, key: `Bs${denom}`, ranges, total, especiales });
      }
      for (const [denom, ranges] of grouped) {
        if (denomOrder.includes(denom)) continue;
        const total = ranges.reduce((acc, r) => acc + (r.e - r.s + 1), 0);
        const especiales: EspecialCardState[] = especialData
          .filter(e => e.denom === denom)
          .map(e => ({ entry: e, open: false, loading: false, subRanges: [], page: 0, pageSize: 50, error: null }));
        built.push({ label: `Bs. ${denom}`, key: `Bs${denom}`, ranges, total, especiales });
      }

      this.groups.set(built);
    } catch {
      this.error.set('No se pudieron cargar los seriales. Intente de nuevo.');
    } finally {
      this.loading.set(false);
    }
  }

  async toggleEspecial(card: EspecialCardState) {
    if (card.open) {
      card.open = false;
      this.groups.update(g => [...g]); // trigger change detection
      return;
    }
    // First open: load the json
    if (card.subRanges.length === 0) {
      card.loading = true;
      card.open = true;
      this.groups.update(g => [...g]);
      try {
        const res = await fetch(`/${card.entry.json}.json`);
        card.subRanges = await res.json();
        card.page = 0;
      } catch {
        card.error = 'No se pudieron cargar los sub-rangos.';
      } finally {
        card.loading = false;
      }
    } else {
      card.open = true;
    }
    this.groups.update(g => [...g]);
  }

  pageRanges(card: EspecialCardState): [number, number][] {
    const start = card.page * card.pageSize;
    return card.subRanges.slice(start, start + card.pageSize);
  }

  totalPages(card: EspecialCardState): number {
    return Math.ceil(card.subRanges.length / card.pageSize);
  }

  goPage(card: EspecialCardState, page: number) {
    card.page = page;
    this.groups.update(g => [...g]);
  }

  formatNum(n: number): string {
    return n.toLocaleString('es-BO');
  }

  totalIllegal(): number {
    return this.groups().reduce((acc, g) => acc + g.total, 0);
  }

  totalRanges(): number {
    return this.groups().reduce((acc, g) => acc + g.ranges.length, 0);
  }

  totalEspecialEntries(): number {
    return this.groups().reduce((acc, g) => acc + g.especiales.length, 0);
  }
}
