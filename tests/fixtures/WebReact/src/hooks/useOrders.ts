import { useState } from 'react';

export function useOrders(limit: number): number[] {
  const [orders] = useState<number[]>([1, 2, 3]);
  return orders.slice(0, limit);
}
