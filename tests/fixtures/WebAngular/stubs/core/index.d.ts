// Synthetic minimal declarations for the Refyntra test fixture (not the real @angular/core).
export declare function Component(meta: { selector?: string; standalone?: boolean; imports?: unknown[]; template?: string; templateUrl?: string; styleUrl?: string; styleUrls?: string[]; styles?: string | string[]; providers?: unknown[] }): ClassDecorator;
export declare function Directive(meta: { selector?: string; standalone?: boolean }): ClassDecorator;
export declare function NgModule(meta: { declarations?: unknown[]; imports?: unknown[]; exports?: unknown[]; providers?: unknown[]; bootstrap?: unknown[] }): ClassDecorator;
export declare function Injectable(meta?: { providedIn?: 'root' | 'platform' | 'any' | null }): ClassDecorator;
export declare function Input(alias?: string): PropertyDecorator;
export declare function Output(alias?: string): PropertyDecorator;
export declare class EventEmitter<T> {
  emit(value?: T): void;
  subscribe(next?: (value: T) => void): unknown;
}
export declare function inject<T>(token: abstract new (...args: any[]) => T): T;
