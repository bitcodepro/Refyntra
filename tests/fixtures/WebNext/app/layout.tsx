export default function RootLayout({ children }: { children?: unknown }) {
  return <html><body>{children as string}</body></html>;
}
