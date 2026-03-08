import { Routes } from '@angular/router';
import { ScannerComponent } from './pages/scanner/scanner.component';
import { LiveScannerComponent } from './pages/live-scanner/live-scanner.component';
import { SerialesComponent } from './pages/seriales/seriales.component';

export const routes: Routes = [
  { path: '', redirectTo: 'en-vivo', pathMatch: 'full' },
  { path: 'foto', component: ScannerComponent },
  { path: 'en-vivo', component: LiveScannerComponent },
  { path: 'seriales', component: SerialesComponent },
  { path: '**', redirectTo: 'en-vivo' },
];
