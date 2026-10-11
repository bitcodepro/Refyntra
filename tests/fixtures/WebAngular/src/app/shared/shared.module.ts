import { NgModule } from '@angular/core';
import { BannerComponent } from './banner.component';
import { AuditService } from './audit.service';

@NgModule({
  declarations: [BannerComponent],
  exports: [BannerComponent],
  providers: [AuditService],
})
export class SharedModule {}
