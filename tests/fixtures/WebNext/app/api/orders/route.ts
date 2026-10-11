export async function GET() {
  return new Response('[]');
}

export async function POST(request: Request) {
  return new Response(await request.text());
}
