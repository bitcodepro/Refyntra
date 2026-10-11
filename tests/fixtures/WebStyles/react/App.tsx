import React from 'react';
import clsx from 'clsx';
import './app.css';

export function App({ on }: { on: boolean }) {
  const el = document.createElement('div');
  el.classList.add('shared');
  return <div id="root" className={clsx('app', { active: on })}>app</div>;
}
