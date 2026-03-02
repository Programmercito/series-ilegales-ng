import { Routes } from '@angular/router';
import { ScannerComponent } from './pages/scanner/scanner.component';
import { SerialesComponent } from './pages/seriales/seriales.component';

export const routes: Routes = [
  { path: '',         component: ScannerComponent },
  { path: 'seriales', component: SerialesComponent },
  { path: '**',       redirectTo: '' },
];
