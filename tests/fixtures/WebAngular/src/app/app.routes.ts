import { Routes } from '@angular/router';
import { OrderListComponent } from './orders/order-list.component';
import { HomeComponent } from './shared/home.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  {
    path: 'orders',
    children: [
      { path: '', component: OrderListComponent },
      { path: ':id', loadComponent: () => import('./orders/order-card.component').then((m) => m.OrderCardComponent) },
    ],
  },
];
