import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-order-card',
  standalone: true,
  templateUrl: './order-card.component.html',
  styleUrls: ['./order-card.component.css'],
})
export class OrderCardComponent {
  @Input() orderId = 0;
  @Input() title = '';
  @Output() selected = new EventEmitter<number>();

  select(): void {
    this.selected.emit(this.orderId);
  }
}
