import { Injectable } from '@angular/core';

@Injectable()
export class AuditService {
  log(message: string): string {
    return message;
  }
}
