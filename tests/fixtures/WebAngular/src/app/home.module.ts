import { NgModule } from '@angular/core';
import { SharedModule } from './shared/shared.module';
import { HomeComponent } from './shared/home.component';

@NgModule({
  declarations: [HomeComponent],
  imports: [SharedModule],
})
export class HomeModule {}
