import { useContext } from 'react';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { Badge } from './components/Badge';
import { useOrders } from './hooks/useOrders';
import { ThemeContext, ThemeProvider } from './context/Theme';

export function App() {
  const orders = useOrders(2);
  const theme = useContext(ThemeContext);
  return (
    <ThemeProvider>
      <Card title={theme} />
      <Button label="Save" size={2} />
      <Button label="Cancel" onClick={() => undefined} />
      <Badge count={orders.length} />
    </ThemeProvider>
  );
}
