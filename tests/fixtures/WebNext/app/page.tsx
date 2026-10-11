import Link from 'next/link';
import { Counter } from './components/Counter';

export default function Home() {
  return (
    <main>
      <Link href="/orders/42">Order 42</Link>
      <Link href="/docs/getting-started/install">Docs</Link>
      <Link href="/nowhere">Missing</Link>
      <Counter start={1} />
    </main>
  );
}
