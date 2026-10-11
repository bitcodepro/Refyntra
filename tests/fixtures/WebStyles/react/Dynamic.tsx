import React from 'react';
import s from './Dynamic.module.scss';

export function Dynamic({ name, tone }: { name: 'a' | 'b'; tone: string }) {
  return <div className={`tone-${tone}`}><span className={s[name]}>x</span></div>;
}
