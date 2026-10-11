// Synthetic minimal declarations for the Refyntra test fixture (not the real @angular/router).
export interface Route {
  path?: string;
  component?: unknown;
  loadComponent?: () => Promise<unknown>;
  loadChildren?: () => Promise<unknown>;
  children?: Route[];
  redirectTo?: string;
}
export type Routes = Route[];
export declare class RouterModule {
  static forRoot(routes: Routes): RouterModule;
  static forChild(routes: Routes): RouterModule;
}
export declare function provideRouter(routes: Routes): unknown;
