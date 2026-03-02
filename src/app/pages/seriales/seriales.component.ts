import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

interface FormatEntry { s: number; e: number; denom: number; p: number; }

interface DenomGroup {
  label: string;
  key: string;
  ranges: FormatEntry[];
  total: number;
}

@Component({
  selector: 'app-seriales',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './seriales.component.html',
  styleUrl: './seriales.component.scss'
})
export class SerialesComponent implements OnInit {
  groups  = signal<DenomGroup[]>([]);
  loading = signal(true);
  error   = signal<string | null>(null);

  async ngOnInit() {
    try {
      const res = await fetch('/formatbcb.json');
      const data: FormatEntry[] = await res.json();

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
        built.push({ label: `Bs. ${denom}`, key: `Bs${denom}`, ranges, total });
      }
      // include any denomination not in the ordered list
      for (const [denom, ranges] of grouped) {
        if (denomOrder.includes(denom)) continue;
        const total = ranges.reduce((acc, r) => acc + (r.e - r.s + 1), 0);
        built.push({ label: `Bs. ${denom}`, key: `Bs${denom}`, ranges, total });
      }

      this.groups.set(built);
    } catch (e) {
      this.error.set('No se pudieron cargar los seriales. Intente de nuevo.');
    } finally {
      this.loading.set(false);
    }
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
}
