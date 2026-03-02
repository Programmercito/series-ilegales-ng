import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

interface SeriesRange { del: number; al: number; }
interface SeriesData  { [key: string]: SeriesRange[]; }

interface DenomGroup {
  label: string;
  key: string;
  ranges: SeriesRange[];
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
      const res = await fetch('/seriesb.json');
      const data: SeriesData = await res.json();

      const denomOrder = ['Bs10', 'Bs20', 'Bs50'];
      const denomLabels: Record<string, string> = {
        'Bs10': 'Bs. 10',
        'Bs20': 'Bs. 20',
        'Bs50': 'Bs. 50',
      };

      const built: DenomGroup[] = [];
      for (const key of denomOrder) {
        if (!data[key]) continue;
        const ranges = data[key];
        const total = ranges.reduce((acc, r) => acc + (r.al - r.del + 1), 0);
        built.push({ label: denomLabels[key] ?? key, key, ranges, total });
      }
      // include any denomination not in the ordered list
      for (const key of Object.keys(data)) {
        if (denomOrder.includes(key)) continue;
        const ranges = data[key];
        const total = ranges.reduce((acc, r) => acc + (r.al - r.del + 1), 0);
        built.push({ label: key.replace('Bs', 'Bs. '), key, ranges, total });
      }

      this.groups.set(built);
    } catch (e) {
      this.error.set('No se pudieron cargar los seriales. Intente de nuevo.');
    } finally {
      this.loading.set(false);
    }
  }

  formatNum(n: number): string {
    return n.toLocaleString('es-VE');
  }

  totalIllegal(): number {
    return this.groups().reduce((acc, g) => acc + g.total, 0);
  }

  totalRanges(): number {
    return this.groups().reduce((acc, g) => acc + g.ranges.length, 0);
  }
}
