'use server';

export async function saveOrder(id: string): Promise<string> {
  const res = await fetch('/api/orders');
  return `${id}:${res.status}`;
}
