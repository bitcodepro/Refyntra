import { Component } from '@angular/core';
import { AuditService } from './audit.service';

@Component({
  selector: 'app-banner',
  standalone: false,
  template: '<p class="banner">{{ text }}</p>',
  styles: ['.banner { font-weight: bold; }'],
})
export class BannerComponent {
  text = 'Hello';
  constructor(private readonly audit: AuditService) {
    this.text = this.audit.log(this.text);
  }
}
