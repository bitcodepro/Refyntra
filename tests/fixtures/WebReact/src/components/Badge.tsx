import { memo } from 'react';

export const Badge = memo((props: { count: number }) => <span>{props.count}</span>);
