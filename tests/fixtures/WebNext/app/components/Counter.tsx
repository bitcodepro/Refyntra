'use client';

import { useRouter } from 'next/navigation';

export function Counter({ start }: { start: number }) {
  const router = useRouter();
  return <button onClick={() => router.push('/orders')}>{start}</button>;
}
