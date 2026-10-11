export default function Order({ params }: { params: { id: string } }) {
  return <h1>{params.id}</h1>;
}
