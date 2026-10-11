import { Component, inject } from '@angular/core';
import { OrderCardComponent } from './order-card.component';
import { OrderService } from './order.service';

@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [OrderCardComponent],
  template: `
    <app-order-card [orderId]="1" title="First" (selected)="onSelected($event)"></app-order-card>
    <app-order-card [orderId]="2" title="Second"></app-order-card>
  `,
})
export class OrderListComponent {
  private readonly orders = inject(OrderService);
  last = 0;

  onSelected(id: number): void {
    this.last = id + this.orders.ids().length;
  }
}
