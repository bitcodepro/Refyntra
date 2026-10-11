import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class OrderService {
  ids(): number[] {
    return [1, 2];
  }
}
