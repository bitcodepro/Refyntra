// Small frontend of the FullStack fixture. Every call below is recognised by Refyntra's HTTP links (heuristic).
import axios from 'axios';

const API = '/api';

export interface Order {
  id: number;
  total: number;
}

export async function loadOrder(id: number): Promise<Order> {
  const res = await fetch(`${API}/orders/${id}`);
  return res.json();
}

export function cancelOrder(id: number) {
  return fetch(API + '/orders/' + id + '/cancel', { method: 'POST' });
}

export function recentOrders() {
  return fetch('/api/orders/recent');
}

export function listProducts() {
  return axios.get('/api/products');
}

export function createProduct(name: string) {
  return axios.post('/api/products', { name });
}

export function findTag(name: string) {
  // Ambiguous: a Minimal API route and an MVC action have the same shape.
  return fetch(`/api/tags/${name}`);
}

export function legacyReport() {
  // No such route: listed by Find "client:".
  return fetch('/api/reports/legacy');
}

export function external() {
  // Another host: never linked unless refyntra.http.origins names it.
  return fetch('https://example.com/api/orders/1');
}
