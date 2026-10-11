// Synthetic minimal declarations for the Refyntra test fixture (not the real React types).
export type ReactNode = string | number | boolean | null | undefined | JSX.Element | ReactNode[];
export interface Context<T> {
  Provider: (props: { value: T; children?: ReactNode }) => JSX.Element;
  Consumer: (props: { children: (value: T) => ReactNode }) => JSX.Element;
}
export declare function createContext<T>(defaultValue: T): Context<T>;
export declare function useContext<T>(context: Context<T>): T;
export declare function useState<T>(initial: T): [T, (value: T) => void];
export declare function memo<P>(component: (props: P) => JSX.Element): (props: P) => JSX.Element;
export declare class Component<P = {}, S = {}> {
  props: P;
  state: S;
  constructor(props: P);
  render(): ReactNode;
}
declare global {
  namespace JSX {
    interface Element {}
    interface ElementClass {
      render(): unknown;
    }
    interface ElementAttributesProperty {
      props: {};
    }
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {
      [name: string]: Record<string, unknown>;
    }
  }
}
